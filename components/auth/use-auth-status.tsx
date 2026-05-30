'use client';

// 05-02 T1: re-export hook so consumers can `import { useAuthStatus }
// from '@/components/auth/use-auth-status'`. The actual implementation lives
// in auth-status-provider.tsx (single module, single source of truth).

export { useAuthStatus, type AuthStatusValue } from './auth-status-provider';
