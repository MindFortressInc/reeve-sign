import type { TFieldCondition } from '@documenso/lib/types/field-meta';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';

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
 *
 * Which controller is selected, and which of its options are checked, is kept
 * as LOCAL draft state rather than derived straight from `condition` — a
 * `ZFieldCondition` requires a non-empty `optionIds` (a zero-option condition
 * could never be satisfied, so it's not a valid persisted shape), but the
 * *UI* still needs to represent "this controller is selected, no options
 * checked yet" as a real, stable intermediate state while the author is
 * choosing. Deriving the controller selection from `condition` directly meant
 * that state couldn't exist: picking a multi-option controller (which starts
 * with nothing checked) or unchecking the last checked option immediately
 * collapsed `condition` to `null`, which in turn made the dropdown snap back
 * to "Always visible" and the option list disappear — multi-option
 * conditions were unauthorable. Local state keeps the dropdown and option
 * list showing whatever the author last picked; `onChange` is only ever
 * called with `null` for the *persisted* value while zero options are
 * checked, never as a reset of the UI itself. The parent must remount this
 * component (e.g. `key={selectedField.formId}`) when the field being edited
 * changes, so this draft state doesn't leak between fields.
 */
export const EditorConditionalVisibilityField = ({
  condition,
  availableCheckboxFields,
  onChange,
}: EditorConditionalVisibilityFieldProps) => {
  const { t } = useLingui();

  const [selectedControllerId, setSelectedControllerId] = useState<number | null>(condition?.fieldId ?? null);
  const [selectedOptionIds, setSelectedOptionIds] = useState<number[]>(condition?.optionIds ?? []);

  const selectedController = availableCheckboxFields.find((field) => field.id === selectedControllerId);

  const handleControllerChange = (value: string) => {
    if (value === ALWAYS_VISIBLE_VALUE) {
      setSelectedControllerId(null);
      setSelectedOptionIds([]);
      onChange(null);
      return;
    }

    const controller = availableCheckboxFields.find((field) => field.id === Number(value));

    if (!controller) {
      return;
    }

    // Default to every option selected ("visible when any option is
    // checked") — always a valid, immediately meaningful, non-empty starting
    // point regardless of how many options the controller has (a single-option
    // checkbox trivially selects its one option). The author can then narrow
    // it down by unchecking specific options.
    const defaultOptionIds = controller.values.map((optionValue) => optionValue.id);

    setSelectedControllerId(controller.id);
    setSelectedOptionIds(defaultOptionIds);
    onChange({ fieldId: controller.id, optionIds: defaultOptionIds });
  };

  const handleOptionToggle = (optionId: number, checked: boolean) => {
    if (selectedControllerId === null) {
      return;
    }

    const nextOptionIds = checked
      ? [...selectedOptionIds, optionId]
      : selectedOptionIds.filter((id) => id !== optionId);

    setSelectedOptionIds(nextOptionIds);

    // Persist `null` while zero options are checked (an unsatisfiable
    // condition is the same as no condition) but keep the controller selected
    // in the UI — re-checking an option immediately restores a valid
    // condition without having to re-pick the controller from the dropdown.
    onChange(nextOptionIds.length > 0 ? { fieldId: selectedControllerId, optionIds: nextOptionIds } : null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <label className="text-foreground/70 text-xs" htmlFor="field-condition-controller">
          <Trans>Visibility</Trans>
        </label>

        <Select
          value={selectedControllerId !== null ? String(selectedControllerId) : ALWAYS_VISIBLE_VALUE}
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
                checked={selectedOptionIds.includes(option.id)}
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
