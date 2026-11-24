// Derived from coollabsio/coolify@91b7e3e:app/Support/ValidationPatterns.php,
// app/Livewire/Project/{AddEmpty,Edit,EnvironmentEdit}.php and
// app/Livewire/Concerns/CreatesEnvironments.php (rules, messages) (Apache-2.0), modified.
//
// The project and environment forms all validate the same two fields:
// 'name' => ValidationPatterns::nameRules(), 'description' =>
// ValidationPatterns::descriptionRules(), with combinedMessages(). The rules
// and messages are the ones the private key forms use (private-keys/validation).
import { descriptionRules, MESSAGES, nameRules, type FieldErrors } from "../private-keys/validation.js";

export interface NameDescriptionInput {
  name: string;
  /** The description as the form sent it; null when it sent none. */
  description: string | null;
}

/**
 * rules() of AddEmpty, Edit, EnvironmentEdit and CreatesEnvironments.
 * combinedMessages() has no `required` message, so a missing name gets
 * Laravel's default: "The name field is required."
 */
export function validateNameAndDescription(body: Record<string, unknown>): { ok: true; input: NameDescriptionInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  nameRules(errors, body.name, MESSAGES.required("name"));
  descriptionRules(errors, body.description);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { name: body.name as string, description: typeof body.description === "string" ? body.description : null } };
}
