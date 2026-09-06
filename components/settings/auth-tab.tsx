'use client';

// 05-02 T2: Settings Auth tab — visibility-state machine.
// Phase 5 Plan 05-02 — AC-5 (5 states A/B/C/D/E).
//
// State derivation server-side per design-system/pages/settings.md §12.2.
// State E (race) emits pino warn auth_state_inconsistency in Server Component.

import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AuthToggle } from './auth-toggle';
import { SetupForm } from './setup-form';
import { AuthAdvanced } from './auth-advanced';
import { AuthDangerZone } from './auth-danger-zone';

export type AuthState = 'A' | 'B' | 'C' | 'D' | 'E';

export interface AuthSettings {
  auth_enabled: 'true' | 'false';
  session_ttl_seconds: string;
  auth_trust_proxy_xff: 'true' | 'false';
  bcrypt_cost: string;
}

interface AuthTabProps {
  state: AuthState;
  initialSettings: AuthSettings;
  userExists: boolean;
}

export function AuthTab({ state, initialSettings, userExists }: AuthTabProps) {
  const t = useTranslations('settings.auth');

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('heading')}</CardTitle>
          <CardDescription>{t('helper')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <AuthToggle
            initialEnabled={initialSettings.auth_enabled === 'true'}
            userExists={userExists}
          />
        </CardContent>
      </Card>

      {state === 'C' && <SetupForm />}

      {(state === 'B' || state === 'C' || state === 'D' || state === 'E') && (
        <AuthAdvanced
          sessionTtlSeconds={initialSettings.session_ttl_seconds}
          trustProxyXff={initialSettings.auth_trust_proxy_xff === 'true'}
          bcryptCost={initialSettings.bcrypt_cost}
        />
      )}

      {userExists && (state === 'B' || state === 'D' || state === 'E') && <AuthDangerZone />}
    </div>
  );
}
