'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { logger } from '@/src/lib/logger';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { SettingsForm, type SettingsFormHandle } from '@/components/settings/settings-form';
import { PathsTabShares } from '@/components/settings/paths-tab-shares';
import { CachePathCard, type CachePathCardProps } from '@/components/settings/cache-path-card';
import { AuthTab, type AuthState, type AuthSettings } from '@/components/settings/auth-tab';
import type { ShareRow } from '@/src/lib/db/schema';
import { BenchSettingsTab } from '@/components/bench/bench-settings-tab';
// Auto-Scan UI surfaces — toggle + status-card live in the General tab,
// rendered AFTER the existing SettingsForm so the form's dirty-state lifecycle
// stays untouched (toggle owns its own PUT via /api/settings).
import { AutoScanToggle } from '@/components/settings/auto-scan-toggle';
import { AutoScanCard } from '@/components/settings/auto-scan-card';
import type { AutoScanAdvancedInitial } from '@/components/settings/auto-scan-advanced';
import { PageContainer, PageHeader } from '@/components/page-layout';
import type { FormValues, RenderDeviceOption } from '@/src/lib/api/settings-serialize';
import type { EncoderId, QsvRateControl } from '@/src/lib/encode';
import type { BenchDefaults } from '@/components/bench/bench-defaults';

// Tab order: 'auth' sits between 'encoder' and 'general'; 'bench' is the fifth tab.
type Tab = 'paths' | 'encoder' | 'auth' | 'general' | 'bench';

export type EncoderDetectionState = {
  detectedEncoders: EncoderId[];
  activeEncoder: EncoderId;
  encoderResolution: 'auto' | 'override' | 'fallback';
  requestedButUnavailable?: EncoderId;
  vaapiDevice?: string;
  // The boot-resolved QSV ratecontrol tier. undefined = both probe
  // tiers failed, qsv was never probed, or settings/page.tsx's detection
  // catch-branch fired. The CRF helper then names the FALLBACK the real encode
  // still emits instead of going silent.
  qsvRateControl?: QsvRateControl;
};

export function SettingsClient({
  defaultValues,
  initialShares,
  cachePath,
  scanRootExists,
  cachePathExists,
  detectedEncoders,
  activeEncoder,
  encoderResolution,
  requestedButUnavailable,
  vaapiDevice,
  qsvRateControl,
  renderDevices,
  authState,
  authSettings,
  userExists,
  benchDefaults,
  autoScanAdvancedInitial,
}: {
  defaultValues: FormValues;
  initialShares: ShareRow[];
  cachePath: CachePathCardProps;
  scanRootExists: boolean;
  cachePathExists: boolean;
  // Live render-node probe list for the Encoder-tab GPU-Device picker.
  renderDevices: RenderDeviceOption[];
  authState: AuthState;
  authSettings: AuthSettings;
  userExists: boolean;
  benchDefaults?: BenchDefaults;
  autoScanAdvancedInitial: AutoScanAdvancedInitial;
} & EncoderDetectionState) {
  const t = useTranslations('settings');
  const [tab, setTab] = useState<Tab>('paths');
  const [pendingTab, setPendingTab] = useState<Tab | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  // Detection state can refresh post-save (form invokes
  // POST /api/encoders/refresh). Track in client state so re-renders
  // reflect the new resolution without a full router.refresh().
  const [detection, setDetection] = useState<EncoderDetectionState>({
    detectedEncoders,
    activeEncoder,
    encoderResolution,
    requestedButUnavailable,
    vaapiDevice,
    qsvRateControl,
  });

  // Precautionary refactor: per-tab Map<Tab, RefObject>
  // replaces the single formRef. With keepMounted=false (current Tabs
  // default) only ONE SettingsForm is ever mounted, so single-ref and Map
  // are functionally equivalent at runtime. The Map's value is to let a
  // future maintainer toggle keepMounted=true without rewriting
  // saveAndSwitch — saveAndSwitch reads getFormRef(tab).current with
  // tab=current-leaving-tab, unambiguous regardless of mount strategy.
  // Lazy-create semantic: getFormRef(t) creates a stable RefObject on first
  // call so React's `ref={getFormRef(t)}` attaches reliably across renders.
  const formRefs = useRef<Map<Tab, React.RefObject<SettingsFormHandle | null>>>(new Map());
  function getFormRef(t: Tab): React.RefObject<SettingsFormHandle | null> {
    let r = formRefs.current.get(t);
    if (!r) {
      r = { current: null };
      formRefs.current.set(t, r);
    }
    return r;
  }
  // AlertDialog Save-and-switch threads an AbortSignal
  // through formRef.submit({signal}) so cancelSwitch can abort the in-flight
  // PUT. Scope-bound to the AlertDialog path; sticky-bar path is signal-free
  // (known limitation).
  const saveAbortRef = useRef<AbortController | null>(null);
  // Stale-closure guard for the
  // saveAndSwitch await uses a ref synced to pendingTab. Reading
  // `pendingTab` after the await would not work because closures freeze state at
  // call time — only a ref reflects the latest value.
  const pendingTabRef = useRef<Tab | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<'validation' | 'network' | null>(null);

  // Clear stale saveError on every dialog open (defensive
  // against future programmatic-tab-switch paths bypassing close handlers)
  // + sync pendingTabRef so the saveAndSwitch await-guard sees latest value.
  useEffect(() => {
    pendingTabRef.current = pendingTab;
    if (pendingTab !== null) setSaveError(null);
  }, [pendingTab]);

  // beforeunload listener wired to dirty state.
  useEffect(() => {
    if (!isDirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Hash-anchor support. `/{locale}/settings#encoder-config`
  // deeplink (used by NotificationBell + Topbar surfaces) opens the Encoder
  // tab + scrolls to the section header. Mounted-check via useEffect ensures
  // SSR safety.
  // #paths handler — explicit setTab('paths') so the
  // onboarding auto-skip toast deeplink is robust against future default-tab
  // reorder. No scroll-into-view (paths content renders above-the-fold).
  // #auto-scan-advanced branch — onboarding AutoScanAwareness
  // deeplink lands on general tab + scrollIntoView the AutoScanAdvanced
  // Collapsible (which auto-opens via its own mount-effect). Single-fire on
  // mount (no hashchange listener), same as the other hash branches.
  //
  // ORDERING INVARIANT: branches that return a cleanup
  // function (cancelAnimationFrame) must come LAST in the if-chain because
  // JS evaluates `if` sequentially — the first matching branch with a
  // `return` short-circuits all subsequent checks. Branches WITHOUT a
  // cleanup-return (e.g. current `#paths`) must sit BEFORE any branch WITH
  // a cleanup-return so the effect-return value remains undefined for those
  // matches. Stable order: encoder-config → paths → auto-scan-advanced.
  // To add a new branch with cleanup: insert BEFORE auto-scan-advanced OR
  // refactor the whole chain to switch-case + return-at-end.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === '#encoder-config') {
      setTab('encoder');
      const id = requestAnimationFrame(() => {
        document.getElementById('encoder-config')?.scrollIntoView({ block: 'start' });
      });
      return () => cancelAnimationFrame(id);
    }
    if (window.location.hash === '#paths') {
      setTab('paths');
    }
    // The onboarding Auto-Crop callout deep-links #auto-crop,
    // but the Auto-Crop Card lives in the non-default tab==='encoder' block → it is
    // unmounted on page load, so native hash-scroll cannot reach it. Mirror the
    // #encoder-config branch (same encoder tab). Cleanup-returning → placed AFTER
    // the non-returning #paths branch per the ordering invariant above.
    if (window.location.hash === '#auto-crop') {
      setTab('encoder');
      const id = requestAnimationFrame(() => {
        document.getElementById('auto-crop')?.scrollIntoView({ block: 'start' });
      });
      return () => cancelAnimationFrame(id);
    }
    // The dashboard "auto-encode is off" card deep-links #auto-encode.
    // The switch lives in PreferencesCard (tab==='general', not the default
    // tab) → same unmounted-on-load problem as #auto-crop.
    if (window.location.hash === '#auto-encode') {
      setTab('general');
      const id = requestAnimationFrame(() => {
        document.getElementById('auto-encode')?.scrollIntoView({ block: 'start' });
      });
      return () => cancelAnimationFrame(id);
    }
    if (window.location.hash === '#auto-scan-advanced') {
      // OBSERVABILITY: emit a single audit-trail line when
      // operator lands here via the onboarding AutoScanAwareness deeplink.
      // Without it there is zero signal whether the onboarding QualityStep
      // hint drives engagement. Single-fire per
      // mount; StrictMode double-mount produces an idempotent duplicate
      // line (acceptable noise; production single).
      logger.info(
        { event: 'onboarding.autoScanHint.engaged', source: 'deeplink' },
        'onboarding auto-scan hint deeplink engaged',
      );
      setTab('general');
      const id = requestAnimationFrame(() => {
        document.getElementById('auto-scan-advanced')?.scrollIntoView({ block: 'start' });
      });
      return () => cancelAnimationFrame(id);
    }
  }, []);

  function onTabChange(next: string) {
    const target = next as Tab;
    if (isDirty && target !== tab) {
      setPendingTab(target);
      return;
    }
    setTab(target);
  }

  function discardAndSwitch() {
    if (pendingTab) {
      setTab(pendingTab);
      setPendingTab(null);
      setSaveError(null);
    }
  }

  function cancelSwitch() {
    // Abort the in-flight AlertDialog Save BEFORE clearing
    // pendingTab. Sequence matters — saveAbortRef.abort() fires AbortError
    // into onSubmit's fetch.catch; setPendingTab(null) ensures the
    // stale-closure guard in saveAndSwitch (pendingTabRef !== targetTab)
    // skips any post-await state mutation that may still resolve.
    saveAbortRef.current?.abort();
    setPendingTab(null);
    setSaveError(null);
  }

  // AlertDialog Save-and-switch path. Reads
  // getFormRef(tab) for the CURRENT-LEAVING tab (Map<Tab,Ref>); threads
  // AbortController.signal into submit({signal}) so cancelSwitch can
  // abort the in-flight PUT. The stale-closure guard via pendingTabRef
  // absorbs the abort path: cancelSwitch sets pendingTab=null first,
  // so when the aborted submit resolves the guard returns early without
  // touching state.
  async function saveAndSwitch() {
    const leavingRef = getFormRef(tab);
    if (!leavingRef.current || !pendingTab) return;
    const targetTab = pendingTab;
    const controller = new AbortController();
    saveAbortRef.current = controller;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await leavingRef.current.submit({ signal: controller.signal });
      if (pendingTabRef.current !== targetTab) return;
      if (result.ok) {
        setTab(targetTab);
        setPendingTab(null);
        setSaveError(null);
      } else if (result.reason === 'validation') {
        setSaveError('validation');
      } else if (result.reason === 'in-flight') {
        // Sync guard against a double submit: a prior submit's microtask
        // release hasn't drained yet.
        // No state mutation — operator's first submit wins; this attempt is
        // a no-op from the dialog's perspective.
        return;
      } else {
        setSaveError('network');
        toast.error(t('unsavedChanges.error.network'));
      }
    } finally {
      setSaving(false);
      // Clear the controller ref so a subsequent saveAndSwitch
      // creates a fresh AbortController (one-shot per dialog flow).
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
    }
  }

  // Derived flag — Save/Discard disabled during ANY
  // in-flight submit (AlertDialog-initiated `saving` OR sticky-save-bar
  // mid-flight via getFormRef(tab).current?.getIsSubmitting()). Cancel STAYS
  // ENABLED — operator can always abort dialog intent.
  // getFormRef(tab) replaces a single formRef. Functionally
  // equivalent under keepMounted=false (only current tab's ref is non-null).
  const submitInFlight = saving || formRefs.current.get(tab)?.current?.getIsSubmitting() === true;

  return (
    <PageContainer variant="form">
      <PageHeader title={t('title')} subhead={t('subhead')} />

      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList variant="line" className="mb-2 w-full justify-start">
          <TabsTrigger value="paths">{t('tab.paths')}</TabsTrigger>
          <TabsTrigger value="encoder">{t('tab.encoder')}</TabsTrigger>
          <TabsTrigger value="auth">{t('tab.auth')}</TabsTrigger>
          <TabsTrigger value="general">{t('tab.general')}</TabsTrigger>
          <TabsTrigger value="bench">{t('tab.bench')}</TabsTrigger>
        </TabsList>
        <TabsContent value="paths" className="mt-6">
          {/* The paths tab renders multi-share
              <PathsTabShares /> (Card-list + inline-edit + cooldown delete + add-form).
              The legacy single-share <SettingsForm tab="paths"> is retired;
              PathsTabShares manages its own dirty/save semantics (self-contained
              like AuthTab) and does NOT feed the cross-tab unsaved-changes
              dialog. */}
          <div className="flex flex-col gap-4">
            <PathsTabShares initialShares={initialShares} />
            {/* Cache card mounts BELOW the shares list. Self-contained
                (owns its own PUT + dirty/save) — does NOT feed the cross-tab
                unsaved-changes dialog, mirroring PathsTabShares. */}
            <CachePathCard {...cachePath} />
          </div>
        </TabsContent>
        <TabsContent value="encoder" className="mt-6">
          <SettingsForm
            ref={getFormRef('encoder')}
            key={`encoder-${JSON.stringify(defaultValues)}-${detection.activeEncoder}`}
            defaultValues={defaultValues}
            tab="encoder"
            scanRootExists={scanRootExists}
            cachePathExists={cachePathExists}
            onDirtyChange={setIsDirty}
            detection={detection}
            onDetectionRefreshed={setDetection}
            renderDevices={renderDevices}
          />
        </TabsContent>
        <TabsContent value="auth" className="mt-6">
          {/* AuthTab self-contained — does not participate in the
              shared SettingsForm dirty-state lifecycle since it owns its own
              per-section save semantics. */}
          <AuthTab state={authState} initialSettings={authSettings} userExists={userExists} />
        </TabsContent>
        <TabsContent value="general" className="mt-6">
          <div className="flex flex-col gap-4">
            <SettingsForm
              ref={getFormRef('general')}
              key={`general-${JSON.stringify(defaultValues)}`}
              defaultValues={defaultValues}
              tab="general"
              scanRootExists={scanRootExists}
              cachePathExists={cachePathExists}
              onDirtyChange={setIsDirty}
              renderDevices={renderDevices}
            />
            <AutoScanToggle />
            {/* Wrapper-only deep-link anchor for the onboarding awareness
                surface: ZERO behavioral change, native
                browser scroll-to-anchor via scroll-margin-top only. */}
            <section id="auto-scan" className="scroll-mt-20">
              <AutoScanCard advancedInitial={autoScanAdvancedInitial} />
            </section>
          </div>
        </TabsContent>
        <TabsContent value="bench" className="mt-6">
          {benchDefaults && <BenchSettingsTab defaults={benchDefaults} />}
        </TabsContent>
      </Tabs>

      <AlertDialog
        open={pendingTab !== null}
        onOpenChange={(o) => {
          // Escape→Cancel via single onOpenChange path.
          // Block close-via-Escape/backdrop during save (Cancel button
          // bypasses this — onClick fires cancelSwitch directly, so the
          // operator can always abort the dialog intent).
          if (!o && !saving) cancelSwitch();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('unsavedChanges.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('unsavedChanges.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          {saveError === 'validation' && (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            >
              {t('unsavedChanges.error.validation')}
            </div>
          )}
          <AlertDialogFooter>
            {/* HIG: least-destructive default — Cancel
                first in DOM order + explicit autoFocus. Stays enabled
                during save: operator can always abort dialog;
                in-flight fetch resolves into stale-closure no-op. */}
            <AlertDialogCancel autoFocus onClick={cancelSwitch}>
              {t('unsavedChanges.action.cancel')}
            </AlertDialogCancel>
            <Button variant="destructive" onClick={discardAndSwitch} disabled={submitInFlight}>
              {t('unsavedChanges.action.discard')}
            </Button>
            <AlertDialogAction onClick={saveAndSwitch} disabled={submitInFlight}>
              {t('unsavedChanges.action.save')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
