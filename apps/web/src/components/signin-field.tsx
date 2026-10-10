import * as React from 'react';
import { Input, Label } from '@/components/ui/primitives';

export function SignInField({
  id,
  label,
  errors,
  ...props
}: Omit<React.ComponentProps<typeof Input>, 'id'> & {
  id: 'email' | 'password';
  label: string;
  errors?: string[];
}) {
  const hasErrors = Boolean(errors?.length);
  const errorId = `signin-${id}-errors`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        {...props}
        id={id}
        aria-invalid={hasErrors || undefined}
        aria-describedby={hasErrors ? errorId : undefined}
      />
      {hasErrors && (
        <div id={errorId}>
          {errors?.map((message, index) => (
            <p key={index} className="mt-1 text-xs text-red-700">
              {message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
