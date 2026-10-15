import type { ServiceType } from '@/types';

export interface WizardServicePoint {
  servicePointId: string;
  name: string;
  displayName?: string;
  capacity: number;
}

export interface WizardData {
  // Step 1: Basic Info
  name: string;
  description: string;
  type: ServiceType;
  requiresName: boolean;
  requiresPhone: boolean;
  allowAnonymous: boolean;
  requiresClearance: boolean;
  displayMode: '' | 'TICKET_ONLY' | 'NAME_AND_TICKET' | 'FULL_INFO';

  // Step 2: Locations
  locationScope: 'specific' | 'all';
  selectedLocationId: string;

  // Step 3: Schedule
  slotDuration: number;
  concurrentLimit: number;
  activeDays: string;
  startTime: string;
  endTime: string;
  isActive: boolean;

  // Step 4: Service Points & Desks
  servicePoints: WizardServicePoint[];
}

export const initialWizardData: WizardData = {
  name: '',
  description: '',
  type: 'GENERAL',
  requiresName: true,
  requiresPhone: false,
  allowAnonymous: false,
  requiresClearance: false,
  displayMode: '',
  locationScope: 'specific',
  selectedLocationId: '',
  slotDuration: 15,
  concurrentLimit: 1,
  activeDays: '1,2,3,4,5',
  startTime: '09:00',
  endTime: '17:00',
  isActive: true,
  servicePoints: [],
};
