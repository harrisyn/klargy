'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import api from '@/api/client';
import { useAuthContext } from './AuthContext';

// Feature types
export interface SubscriptionFeatures {
  multiLocation: boolean;
  maxLocations: number;
  maxServices: number;
  maxUsers: number;
  smsNotifications: boolean;
  whatsappNotifications: boolean;
  ownPaymentKeys: boolean;
  analytics: boolean;
  apiAccess: boolean;
  emrIntegration: boolean;
  customBranding: boolean;
  customDomain: boolean;
  serviceFlows: boolean;
  servicePoints: boolean;
}

export interface LimitInfo {
  current: number;
  limit: number;
  allowed: boolean;
}

export interface SubscriptionInfo {
  planId: string | null;
  planName: string | null;
  planCode: string | null;
  status: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
}

interface SubscriptionContextType {
  subscription: SubscriptionInfo | null;
  features: SubscriptionFeatures;
  limits: {
    locations: LimitInfo;
    services: LimitInfo;
    users: LimitInfo;
  };
  activeProviders: string[];
  organizationStatus: 'ACTIVE' | 'PAUSED';
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  hasFeature: (feature: keyof SubscriptionFeatures) => boolean;
  canCreate: (resource: 'locations' | 'services' | 'users') => boolean;
  getRemainingCount: (resource: 'locations' | 'services' | 'users') => number;
}

// Default values for free tier
const DEFAULT_FEATURES: SubscriptionFeatures = {
  multiLocation: false,
  maxLocations: 1,
  maxServices: 3,
  maxUsers: 5,
  smsNotifications: false,
  whatsappNotifications: false,
  ownPaymentKeys: false,
  analytics: false,
  apiAccess: false,
  emrIntegration: false,
  customBranding: false,
  customDomain: false,
  serviceFlows: false,
  servicePoints: true,
};

const DEFAULT_LIMITS = {
  locations: { current: 0, limit: 1, allowed: true },
  services: { current: 0, limit: 3, allowed: true },
  users: { current: 0, limit: 5, allowed: true },
};

const SubscriptionContext = createContext<SubscriptionContextType | null>(null);

export const SubscriptionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuthContext();
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [features, setFeatures] = useState<SubscriptionFeatures>(DEFAULT_FEATURES);
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [activeProviders, setActiveProviders] = useState<string[]>([]);
  const [organizationStatus, setOrganizationStatus] = useState<'ACTIVE' | 'PAUSED'>('ACTIVE');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSubscription = useCallback(async () => {
    if (!isAuthenticated) {
      setSubscription(null);
      setFeatures(DEFAULT_FEATURES);
      setLimits(DEFAULT_LIMITS);
      setActiveProviders([]);
      setOrganizationStatus('ACTIVE');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const data = await api.getMySubscription();
      setSubscription(data.subscription);
      // Only backfill DEFAULT_FEATURES when there's no subscription at all.
      // When the backend deliberately sends `features: {}` for an
      // EXPIRED-no-fallback org (a locked-down account), merging in the
      // defaults here would silently re-enable every feature client-side
      // and undo the lockdown.
      setFeatures(data.subscription === null ? { ...DEFAULT_FEATURES, ...data.features } : { ...data.features } as typeof DEFAULT_FEATURES);
      setLimits(data.limits);
      setActiveProviders(data.activeProviders || []);
      setOrganizationStatus(data.organizationStatus || 'ACTIVE');
    } catch (err) {
      console.error('Failed to fetch subscription:', err);
      setError('Failed to load subscription info');
      // Use defaults on error
      setSubscription(null);
      setFeatures(DEFAULT_FEATURES);
      setLimits(DEFAULT_LIMITS);
      setActiveProviders([]);
      setOrganizationStatus('ACTIVE');
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  const hasFeature = useCallback((feature: keyof SubscriptionFeatures): boolean => {
    return !!features[feature];
  }, [features]);

  const canCreate = useCallback((resource: 'locations' | 'services' | 'users'): boolean => {
    return limits[resource].allowed;
  }, [limits]);

  const getRemainingCount = useCallback((resource: 'locations' | 'services' | 'users'): number => {
    const { current, limit } = limits[resource];
    return Math.max(0, limit - current);
  }, [limits]);

  return (
    <SubscriptionContext.Provider
      value={{
        subscription,
        features,
        limits,
        activeProviders,
        organizationStatus,
        loading,
        error,
        refresh: fetchSubscription,
        hasFeature,
        canCreate,
        getRemainingCount,
      }}
    >
      {children}
    </SubscriptionContext.Provider>
  );
};

export const useSubscription = () => {
  const context = useContext(SubscriptionContext);
  if (!context) {
    throw new Error('useSubscription must be used within SubscriptionProvider');
  }
  return context;
};

// Feature gate component - renders children only if feature is available
export const FeatureGate: React.FC<{
  feature: keyof SubscriptionFeatures;
  children: ReactNode;
  fallback?: ReactNode;
}> = ({ feature, children, fallback = null }) => {
  const { hasFeature, loading } = useSubscription();

  if (loading) return null;
  if (!hasFeature(feature)) return <>{fallback}</>;
  return <>{children}</>;
};

// Limit gate component - renders children only if limit allows creation
export const LimitGate: React.FC<{
  resource: 'locations' | 'services' | 'users';
  children: ReactNode;
  fallback?: ReactNode;
}> = ({ resource, children, fallback = null }) => {
  const { canCreate, loading } = useSubscription();

  if (loading) return null;
  if (!canCreate(resource)) return <>{fallback}</>;
  return <>{children}</>;
};

// Shown where a plan limit or feature stops an action. Informational, not
// an error: say what the plan includes and where to get more.
const FEATURE_NAMES: Record<keyof SubscriptionFeatures, string> = {
  multiLocation: 'More than one location',
  maxLocations: 'More locations',
  maxServices: 'More services',
  maxUsers: 'More staff',
  smsNotifications: 'Text message alerts',
  whatsappNotifications: 'WhatsApp messages',
  ownPaymentKeys: 'Your own payment account for bookings',
  analytics: 'Analytics',
  apiAccess: 'API access',
  emrIntegration: 'Connecting your CRM, POS or other system',
  customBranding: 'Your own branding',
  customDomain: 'A custom domain',
  serviceFlows: 'Journeys between services',
  servicePoints: 'Desks and rooms',
};
const RESOURCE_WORDS = { locations: ['location', 'locations'], services: ['service', 'services'], users: ['staff account', 'staff accounts'] } as const;

export const UpgradePrompt: React.FC<{
  feature?: keyof SubscriptionFeatures;
  resource?: 'locations' | 'services' | 'users';
  className?: string;
}> = ({ feature, resource, className }) => {
  const { limits } = useSubscription();

  let message = 'Your plan doesn’t include this.';
  if (feature) message = `${FEATURE_NAMES[feature]} isn’t included in your plan.`;
  if (resource) {
    const n = limits[resource].limit;
    const [one, many] = RESOURCE_WORDS[resource];
    message = `Your plan includes ${n === 1 ? `one ${one}` : `${n} ${many}`}, and you’re using ${n === 1 ? 'it' : 'them all'}.`;
  }

  return (
    <div className={`upgrade-note ${className || ''}`} role="note">
      <span>{message}</span>
      <a href="/admin/billing">See plans</a>
    </div>
  );
};

export default SubscriptionContext;
