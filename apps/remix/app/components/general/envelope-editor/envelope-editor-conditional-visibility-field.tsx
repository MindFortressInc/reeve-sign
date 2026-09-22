import type { TFieldCondition } from '@documenso/lib/types/field-meta';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { Trans, useLingui } from '@lingui/react/macro';

export type ConditionalVisibilityCheckboxOption = {
  id: number;
  label: string;
  values: { id: number; value: string }[];
};

type EditorConditionalVisibilityFieldProps = {
  condition: TFieldCondition | null | undefined;
  availableCheckboxFields: ConditionalVisibilityCheckboxOption[];
  onChange: (condition: TFieldCondition | null) => void;
};

const ALWAYS_VISIBLE_VALUE = '__always_visible__';

/**
 * Shared conditional-visibility control for the native v2 field editor. Lives
 * outside the per-type `EditorField*Form` components (unlike `required`/
 * `readOnly`) because `condition` is a base-level property every field type
 * shares, and this control needs the full field list (to offer eligible
 * checkbox controllers) rather than just the one field being edited.
 *
 * Only PERSISTED checkbox fields (a real database id) are offered as
 * controllers — a field still being drafted client-side only has a `formId`
 * until autosave assigns it a real id, and the bulk save endpoint only
 * accepts a condition targeting an already-existing field (see
 * `resolveBulkFieldConditions` in `field-conditions.ts`). In practice a
 * checkbox is usually persisted within ~1s of being placed, so this is a
 * minor authoring-order nicety, not a missing capability.
 */
export const EditorConditionalVisibilityField = ({
  condition,
  availableCheckboxFields,
  onChange,
}: EditorConditionalVisibilityFieldProps) => {
  const { t } = useLingui();

  const selectedController = availableCheckboxFields.find((field) => field.id === condition?.fieldId);

  const handleControllerChange = (value: string) => {
    if (value === ALWAYS_VISIBLE_VALUE) {
      onChange(null);
      return;
    }

    const controller = availableCheckboxFields.find((field) => field.id === Number(value));

    if (!controller) {
      return;
    }

    // Single-option checkbox (the common case, e.g. a plain "I have a
    // co-buyer" toggle): default to that one option so there's nothing extra
    // to configure. Multi-option checkboxes start with none selected.
    const defaultOptionIds = controller.values.length === 1 ? [controller.values[0].id] : [];

    if (defaultOptionIds.length === 0) {
      onChange(null);
      return;
    }

    onChange({ fieldId: controller.id, optionIds: defaultOptionIds });
  };

  const handleOptionToggle = (optionId: number, checked: boolean) => {
    if (!condition) {
      return;
    }

    const optionIds = checked
      ? [...condition.optionIds, optionId]
      : condition.optionIds.filter((id) => id !== optionId);

    onChange(optionIds.length > 0 ? { ...condition, optionIds } : null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <label className="text-foreground/70 text-xs" htmlFor="field-condition-controller">
          <Trans>Visibility</Trans>
        </label>

        <Select
          value={condition ? String(condition.fieldId) : ALWAYS_VISIBLE_VALUE}
          onValueChange={handleControllerChange}
        >
          <SelectTrigger
            id="field-condition-controller"
            data-testid="field-form-condition-controller"
            className="w-full bg-background"
          >
            <SelectValue placeholder={t`Always visible`} />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={ALWAYS_VISIBLE_VALUE}>
              <Trans>Always visible</Trans>
            </SelectItem>

            {availableCheckboxFields.map((field) => (
              <SelectItem key={field.id} value={String(field.id)}>
                <Trans>Show when "{field.label}" is checked</Trans>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedController && selectedController.values.length > 1 && (
        <div className="flex flex-col gap-1 pl-1">
          <p className="text-muted-foreground text-xs">
            <Trans>Visible when any of these options are checked:</Trans>
          </p>

          {selectedController.values.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                data-testid={`field-form-condition-option-${option.id}`}
                checked={condition?.optionIds.includes(option.id) ?? false}
                onCheckedChange={(checked) => handleOptionToggle(option.id, checked === true)}
              />
              {option.value || t`Untitled option`}
            </label>
          ))}
        </div>
      )}
    </div>
  );
};
