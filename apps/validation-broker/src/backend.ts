import type { ValidationInput, ValidationResult } from '@codelens/validation-executor';
import type { ApprovedProfile } from './profile';
/** A backend must enforce the entire fixed profile or reject it; never downgrade isolation. */
export interface ValidationBackend {
  readonly kind: 'docker-local-proof' | 'gvisor' | 'vm';
  reconcile(): Promise<void>;
  execute(
    input: ValidationInput,
    profile: ApprovedProfile,
    correlation: string,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<ValidationResult>;
}
