import { PrismaClient, Platform, SyncItem } from '@prisma/client';
import { ValidationError, NotFoundError, AppError } from '../utils/errors';
import { ShopifyIntegration, createShopifyIntegration } from '../integrations/shopify';
import { CarrierDetectionEngine } from '../integrations/carriers';
import logger from '../utils/logger';

const prisma = new PrismaClient();

export interface SyncItemInput {
  orderId: string;
  trackingNumber: string;
  carrier?: string;
}

export interface SyncBatchResult {
  id: string;
  platform: Platform;
  total: number;
  success: number;
  failed: number;
  items: Array<{
    orderId: string;
    trackingNumber: string;
    status: 'SYNCED' | 'FAILED';
    errorMessage?: string;
    carrier?: string;
  }>;
}

export class SyncService {
  /**
   * Create a new sync batch
   */
  async createSyncBatch(
    userId: string,
    platform: Platform,
    inputMethod: 'CSV' | 'MANUAL' | 'API' | 'WEBHOOK' | 'INTEGRATION',
    items: SyncItemInput[],
    fileName?: string
  ) {
    if (!items || items.length === 0) {
      throw new ValidationError('At least one item is required');
    }

    if (items.length > 1000) {
      throw new ValidationError('Maximum 1000 items per sync');
    }

    // Create batch
    const batch = await prisma.syncBatch.create({
      data: {
        userId,
        platform,
        inputMethod,
        fileName,
        total: items.length,
        status: 'PENDING',
        items: {
          create: items.map((item) => {
            // Auto-detect carrier if not provided
            const carrierMatch = CarrierDetectionEngine.detect(item.trackingNumber);

            return {
              orderId: item.orderId,
              trackingNumber: item.trackingNumber,
              carrier: item.carrier || carrierMatch.carrier,
              status: 'PENDING',
            };
          }),
        },
      },
      include: { items: true },
    });

    return batch;
  }

  /**
   * Get sync batch details
   */
  async getSyncBatch(userId: string, batchId: string) {
    const batch = await prisma.syncBatch.findFirst({
      where: {
        id: batchId,
        userId,
      },
      include: {
        items: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!batch) {
      throw new NotFoundError('Sync batch not found');
    }

    return batch;
  }

  /**
   * Get user's sync history
   */
  async getUserSyncs(userId: string, limit = 20, offset = 0) {
    const batches = await prisma.syncBatch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        items: {
          take: 3, // Show first 3 items in list view
        },
      },
    });

    const total = await prisma.syncBatch.count({ where: { userId } });

    return { batches, total };
  }

  /**
   * Process sync batch (main workhorse)
   * Syncs items to Shopify/Amazon
   */
  async processSyncBatch(userId: string, batchId: string) {
    const batch = await this.getSyncBatch(userId, batchId);

    if (batch.status !== 'PENDING') {
      throw new ValidationError('Batch is already being processed or completed');
    }

    // Update batch status
    await prisma.syncBatch.update({
      where: { id: batchId },
      data: { status: 'PROCESSING' },
    });

    try {
      const results = await this.syncBatchItems(userId, batch.platform, batch.items);

      // Update batch with results
      const successful = results.filter((r) => r.status === 'SYNCED').length;
      const failed = results.filter((r) => r.status === 'FAILED').length;

      await prisma.syncBatch.update({
        where: { id: batchId },
        data: {
          status: 'COMPLETED',
          success: successful,
          failed: failed,
          completedAt: new Date(),
        },
      });

      // Update individual items
      for (const result of results) {
        // Find the item by batchId and orderId
        const item = batch.items.find((i) => i.orderId === result.orderId);
        if (!item) continue;

        if (result.status === 'SYNCED') {
          await prisma.syncItem.update({
            where: { id: item.id },
            data: {
              status: 'SYNCED',
              syncedAt: new Date(),
            },
          });
        } else {
          await prisma.syncItem.update({
            where: { id: item.id },
            data: {
              status: 'FAILED',
              errorMessage: result.errorMessage,
            },
          });
        }
      }

      logger.info(`Sync batch completed`, {
        batchId,
        userId,
        successful,
        failed,
      });

      return { batchId, successful, failed };
    } catch (error) {
      // Mark batch as failed
      await prisma.syncBatch.update({
        where: { id: batchId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
        },
      });

      logger.error(`Sync batch failed`, {
        batchId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Sync items to platform (Shopify or Amazon)
   */
  private async syncBatchItems(userId: string, platform: Platform, items: SyncItem[]) {
    const results: Array<{ orderId: string; status: 'SYNCED' | 'FAILED'; errorMessage?: string }> = [];

    for (const item of items) {
      try {
        if (platform === 'SHOPIFY') {
          await this.syncToShopify(userId, item);
        } else if (platform === 'AMAZON') {
          await this.syncToAmazon(userId, item);
        }

        results.push({
          orderId: item.orderId,
          status: 'SYNCED',
        });
      } catch (error) {
        results.push({
          orderId: item.orderId,
          status: 'FAILED',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  /**
   * Sync to Shopify
   */
  private async syncToShopify(userId: string, item: SyncItem) {
    // Get active Shopify integration
    const integration = await prisma.integration.findFirst({
      where: {
        userId,
        platform: 'SHOPIFY',
        isActive: true,
      },
    });

    if (!integration || !integration.shopUrl) {
      throw new AppError('Shopify store not connected');
    }

    const shopify = createShopifyIntegration(
      `${process.env.FRONTEND_URL}/integrations/shopify/callback`
    );

    // For now, log the sync attempt
    // TODO: Implement actual Shopify fulfillment API call
    logger.info(`Syncing to Shopify`, {
      orderId: item.orderId,
      tracking: item.trackingNumber,
      shop: integration.shopUrl,
    });

    // In production, this would call:
    // const lineItems = await shopify.getFulfillmentOrders(...);
    // await shopify.fulfillOrder(...);
  }

  /**
   * Sync to Amazon
   */
  private async syncToAmazon(userId: string, item: SyncItem) {
    // Get active Amazon integration
    const integration = await prisma.integration.findFirst({
      where: {
        userId,
        platform: 'AMAZON',
        isActive: true,
      },
    });

    if (!integration) {
      throw new AppError('Amazon seller account not connected');
    }

    // TODO: Implement Amazon SP-API fulfillment
    logger.info(`Syncing to Amazon`, {
      orderId: item.orderId,
      tracking: item.trackingNumber,
      seller: integration.sellerId,
    });
  }

  /**
   * Retry failed sync item
   */
  async retrySyncItem(userId: string, batchId: string, itemId: string) {
    // Get batch (verify ownership)
    const batch = await this.getSyncBatch(userId, batchId);

    // Get item
    const item = batch.items.find((i) => i.id === itemId);
    if (!item) {
      throw new NotFoundError('Sync item not found');
    }

    if (item.status !== 'FAILED') {
      throw new ValidationError('Only failed items can be retried');
    }

    // Retry the sync
    try {
      await this.syncBatchItems(userId, batch.platform, [item]);

      // Mark as synced
      await prisma.syncItem.update({
        where: { id: itemId },
        data: {
          status: 'SYNCED',
          syncedAt: new Date(),
          retryCount: { increment: 1 },
        },
      });

      // Update batch stats
      const updated = await prisma.syncBatch.findUnique({
        where: { id: batchId },
        include: { items: true },
      });

      const successful = updated!.items.filter((i) => i.status === 'SYNCED').length;
      const failed = updated!.items.filter((i) => i.status === 'FAILED').length;

      await prisma.syncBatch.update({
        where: { id: batchId },
        data: { success: successful, failed },
      });

      return { success: true };
    } catch (error) {
      throw new AppError(`Failed to retry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete sync batch
   */
  async deleteSyncBatch(userId: string, batchId: string) {
    const batch = await this.getSyncBatch(userId, batchId);

    if (batch.status === 'PROCESSING') {
      throw new ValidationError('Cannot delete a batch that is processing');
    }

    // Delete items first (cascade would work, but being explicit)
    await prisma.syncItem.deleteMany({
      where: { batchId },
    });

    // Delete batch
    await prisma.syncBatch.delete({
      where: { id: batchId },
    });

    return { success: true };
  }
}

export const syncService = new SyncService();
