import prisma from '../../lib/prisma';
import { ProviderName } from './types';

export async function wasAlreadyProcessed(provider: string, eventId: string): Promise<boolean> {
  const existing = await prisma.processedWebhookEvent.findUnique({
    where: { provider_eventId: { provider, eventId } },
  });
  return existing !== null;
}

export async function markProcessed(provider: string, eventId: string): Promise<void> {
  await prisma.processedWebhookEvent.create({
    data: { provider, eventId },
  });
}
