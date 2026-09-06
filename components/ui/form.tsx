'use client';

// Hand-rolled shadcn Form wrapper — `npx shadcn add form` silent-skipped twice
// (01-02 + 01-04 retry). API surface mirrors the shadcn standard so future
// migration to the CLI-installed version (when it is fixed upstream) is
// drop-in: import sites do not change. See 01-04 PLAN Task 2 + CONTEXT §9.

import * as React from 'react';
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';

import { cn } from '@/lib/utils';

const Form = FormProvider;

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName;
};

const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue);

function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({ ...props }: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

type FormItemContextValue = { id: string };
const FormItemContext = React.createContext<FormItemContextValue>({} as FormItemContextValue);

function useFormField() {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();
  const fieldState = getFieldState(fieldContext.name, formState);

  if (!fieldContext) {
    throw new Error('useFormField must be used within <FormField>');
  }
  const { id } = itemContext;
  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  };
}

function FormItem({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const id = React.useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div className={cn('flex flex-col gap-1.5', className)} {...props} />
    </FormItemContext.Provider>
  );
}

function FormLabel({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  const { error, formItemId } = useFormField();
  return (
    <label
      htmlFor={formItemId}
      className={cn(
        'text-sm font-medium leading-none text-foreground',
        error && 'text-destructive',
        className,
      )}
      {...props}
    />
  );
}

function FormControl({
  children,
  ...props
}: { children: React.ReactElement } & React.HTMLAttributes<HTMLDivElement>) {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
  // Clone the child input/select to wire id + aria-describedby + aria-invalid.
  const child = React.cloneElement(
    children as React.ReactElement<Record<string, unknown>>,
    {
      id: formItemId,
      'aria-describedby': error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId,
      'aria-invalid': !!error,
    },
  );
  return <div {...props}>{child}</div>;
}

function FormDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  const { formDescriptionId } = useFormField();
  return (
    <p
      id={formDescriptionId}
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}

function FormMessage({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error.message ?? '') : children;
  if (!body) return null;
  return (
    <p
      id={formMessageId}
      role="alert"
      className={cn('text-xs font-medium text-destructive', className)}
      {...props}
    >
      {body}
    </p>
  );
}

export {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
};
