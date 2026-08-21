'use client';

import * as React from 'react';
import { type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { type FormValues, type RenderDeviceOption } from '@/src/lib/api/settings-serialize';

// 34-02: operator-facing GPU device picker. A controlled shadcn/base-ui Select
// (mirroring the output-container-field FormField→FormItem→FormLabel→Select→
// FormDescription→FormMessage idiom). The "Auto (first detected)" option carries
// the empty-string sentinel ('') — legal because components/ui/select.tsx wraps
// @base-ui/react/select (NOT Radix, which forbids empty-string item values). Each
// probed render node uses the FULL /dev/dri/renderD<N> path as its value (= the
// persisted gpu_device). A pinned-but-currently-absent device (AC-4) is injected
// as an extra option so the operator's selection survives a probe that no longer
// lists it. Empty=Auto semantics live in the persistent FormDescription (NOT
// placeholder-only), per the forms helper-text rule.
//
// Re-exports RenderDeviceOption (defined in settings-serialize, the neutral home
// shared by the server route + SSR page) so call-sites can import the shape from
// the field they render.
export type { RenderDeviceOption } from '@/src/lib/api/settings-serialize';

type GpuDeviceFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  renderDevices: RenderDeviceOption[];
};

export function GpuDeviceField({
  control,
  t,
  renderDevices,
}: GpuDeviceFieldProps): React.ReactElement {
  return (
    <FormField
      control={control}
      name="gpu_device"
      render={({ field, fieldState }) => {
        // Build the option list: probed nodes + (AC-4) the current value when it
        // is non-empty AND not present in the live probe (pinned-but-absent).
        const options: RenderDeviceOption[] = [...renderDevices];
        const cur = field.value;
        if (cur && cur !== '' && !options.some((o) => o.path === cur)) {
          options.push({
            path: cur,
            node: cur.split('/').pop() ?? cur,
            exists: false,
            readable: false,
            writable: false,
            groupName: null,
            inRenderGroup: false,
          });
        }
        return (
          <FormItem>
            <FormLabel htmlFor="gpu_device">{t('field.gpuDevice.label')}</FormLabel>
            <FormControl>
              <Select value={field.value ?? ''} onValueChange={field.onChange}>
                <SelectTrigger
                  id="gpu_device"
                  className="w-full h-11 lg:h-9"
                  aria-label={t('field.gpuDevice.label')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t('field.gpuDevice.autoOption')}</SelectItem>
                  {options.map((opt) => (
                    <SelectItem key={opt.path} value={opt.path}>
                      <span>{opt.node}</span>
                      {!opt.exists ? (
                        <span className="text-muted-foreground">
                          {t('field.gpuDevice.notPresentHint')}
                        </span>
                      ) : opt.groupName ? (
                        <span className="text-muted-foreground">
                          {t('field.gpuDevice.accessHint', {
                            group: opt.groupName,
                            access: opt.writable
                              ? t('field.gpuDevice.access.readWrite')
                              : opt.readable
                                ? t('field.gpuDevice.access.readOnly')
                                : t('field.gpuDevice.access.noAccess'),
                          })}
                        </span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormControl>
            <FormDescription>{t('field.gpuDevice.description')}</FormDescription>
            <FormMessage>{fieldState.error?.message}</FormMessage>
          </FormItem>
        );
      }}
    />
  );
}
