import { PrismaClient } from '@prisma/client';
import { NotFoundError, ValidationError } from '../utils/errors';
import { createShopifyIntegration } from '../integrations/shopify';
import crypto from 'crypto';

const prisma = new PrismaClient();

export class IntegrationService {
  /**
   * Get all integrations for a user
   */
  async getUserIntegrations(userId: string) {
    return prisma.integration.findMany({
      where: { userId },
      select: {
        id: true,
        platform: true,
        isActive: true,
        shopUrl: true,
        lastSyncedAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Get a specific integration
   */
  async getIntegration(userId: string, integrationId: string) {
    const integration = await prisma.integration.findFirst({
      where: {
        id: integrationId,
        userId,
      },
    });

    if (!integration) {
      throw new NotFoundError('Integration not found');
    }

    return integration;
  }

  /**
   * Create Shopify OAuth authorization URL
   */
  createShopifyAuthUrl(nonce: string, redirectUri: string): string {
    const shopify = createShopifyIntegration(redirectUri);

    // Shop URL will be extracted from request in controller
    // This returns the base URL structure
    return shopify.getAuthorizationUrl('{shop}.myshopify.com', nonce);
  }

  /**
   * Handle Shopify OAuth callback
   */
  async handleShopifyCallback(
    userId: string,
    shop: string,
    code: string,
    redirectUri: string
  ) {
    if (!shop || !code) {
      throw new ValidationError('Missing shop or code parameter');
    }

    // Normalize shop URL
    const normalizedShop = shop.includes('.myshopify.com')
      ? shop
      : `${shop}.myshopify.com`;

    try {
      const shopify = createShopifyIntegration(redirectUri);

      // Exchange code for token
      const { accessToken, scope } = await shopify.exchangeCodeForToken(
        normalizedShop,
        code
      );

      // Get store info
      const storeInfo = await shopify.getStore(normalizedShop, accessToken);

      // Check if integration already exists
      let integration = await prisma.integration.findFirst({
        where: {
          userId,
          platform: 'SHOPIFY',
        },
      });

      if (integration) {
        // Update existing
        integration = await prisma.integration.update({
          where: { id: integration.id },
          data: {
            accessToken,
            shopUrl: normalizedShop,
            isActive: true,
          },
        });
      } else {
        // Create new
        integration = await prisma.integration.create({
          data: {
            userId,
            platform: 'SHOPIFY',
            accessToken,
            shopUrl: normalizedShop,
            isActive: true,
          },
        });
      }

      return {
        id: integration.id,
        platform: integration.platform,
        shop: storeInfo.name,
        shopUrl: normalizedShop,
        email: storeInfo.email,
        currency: storeInfo.currency,
      };
    } catch (error) {
      throw new ValidationError(
        `Failed to connect Shopify store: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Connect Amazon SP-API
   */
  async connectAmazon(
    userId: string,
    clientId: string,
    clientSecret: string,
    sellerCentralId: string,
    marketplaceId: string = 'ATVPDKIKX0DER' // US default
  ) {
    if (!clientId || !clientSecret || !sellerCentralId) {
      throw new ValidationError(
        'Client ID, Client Secret, and Seller Central ID are required'
      );
    }

    // Check if already connected
    let integration = await prisma.integration.findFirst({
      where: {
        userId,
        platform: 'AMAZON',
      },
    });

    // Encrypt sensitive data before storing (basic example)
    const encryptedSecret = clientSecret; // TODO: Use proper encryption

    if (integration) {
      integration = await prisma.integration.update({
        where: { id: integration.id },
        data: {
          accessToken: clientId,
          refreshToken: encryptedSecret,
          sellerId: sellerCentralId,
          marketplaceId,
          isActive: true,
        },
      });
    } else {
      integration = await prisma.integration.create({
        data: {
          userId,
          platform: 'AMAZON',
          accessToken: clientId,
          refreshToken: encryptedSecret,
          sellerId: sellerCentralId,
          marketplaceId,
          isActive: true,
        },
      });
    }

    return {
      id: integration.id,
      platform: integration.platform,
      sellerId: sellerCentralId,
      marketplaceId,
    };
  }

  /**
   * Disconnect integration
   */
  async disconnectIntegration(userId: string, integrationId: string) {
    const integration = await this.getIntegration(userId, integrationId);

    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        isActive: false,
        accessToken: '', // Clear sensitive data
        refreshToken: null,
      },
    });

    return { success: true };
  }

  /**
   * Update last synced timestamp
   */
  async updateLastSynced(integrationId: string) {
    return prisma.integration.update({
      where: { id: integrationId },
      data: { lastSyncedAt: new Date() },
    });
  }

  /**
   * Get active Shopify integration for user
   */
  async getActiveShopifyIntegration(userId: string) {
    return prisma.integration.findFirst({
      where: {
        userId,
        platform: 'SHOPIFY',
        isActive: true,
      },
    });
  }

  /**
   * Get active Amazon integration for user
   */
  async getActiveAmazonIntegration(userId: string) {
    return prisma.integration.findFirst({
      where: {
        userId,
        platform: 'AMAZON',
        isActive: true,
      },
    });
  }
}

export const integrationService = new IntegrationService();
