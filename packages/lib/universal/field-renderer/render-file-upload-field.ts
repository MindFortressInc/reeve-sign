import Konva from 'konva';

import { parseFileUploadCustomText } from '../../types/field-file-upload';
import type { TFileUploadFieldMeta } from '../../types/field-meta';
import {
  FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN,
  FIELD_DEFAULT_LETTER_SPACING,
  FIELD_DEFAULT_LINE_HEIGHT,
} from '../../types/field-meta';
import { calculateOverflowLayout } from './calculate-overflow-layout';
import {
  createFieldHoverInteraction,
  konvaTextFill,
  konvaTextFontFamily,
  upsertFieldGroup,
  upsertFieldRect,
} from './field-generic-items';
import type { FieldToRender, RenderFieldElementOptions } from './field-renderer';
import { calculateFieldPosition } from './field-renderer';

const DEFAULT_TEXT_X_PADDING = 6;
const DEFAULT_FILE_UPLOAD_FONT_SIZE = 12;

/**
 * Never renders the raw customText JSON blob — parses it and shows the
 * original filename with a paperclip marker, or the field's label/type name
 * when nothing has been uploaded yet.
 */
export const renderFileUploadFieldElement = (field: FieldToRender, options: RenderFieldElementOptions) => {
  const { mode = 'edit', pageLayer, pageWidth, pageHeight, color, translations } = options;

  const fieldMeta = field.fieldMeta as TFileUploadFieldMeta | undefined;

  const isFirstRender = !pageLayer.findOne(`#${field.renderId}`);

  const fieldGroup = upsertFieldGroup(field, options);
  fieldGroup.removeChildren();
  fieldGroup.off('transform');

  if (isFirstRender) {
    pageLayer.add(fieldGroup);
  }

  const fieldRect = upsertFieldRect(field, options);

  const { fieldWidth, fieldHeight } = calculateFieldPosition(field, pageWidth, pageHeight);

  const fieldTypeName = translations?.[field.type] || field.type;

  const uploadedFile = field.inserted ? parseFileUploadCustomText(field.customText) : null;

  const isLabel = !uploadedFile;
  const textToRender =
    mode === 'export' && !uploadedFile
      ? ''
      : uploadedFile
        ? `📎 ${uploadedFile.fileName}`
        : fieldMeta?.label || fieldTypeName;

  const fontSize = fieldMeta?.fontSize || DEFAULT_FILE_UPLOAD_FONT_SIZE;

  const overflowLayout = calculateOverflowLayout({
    overflowMode: 'crop',
    isLabel,
    textToRender,
    fontSize,
    fontFamily: konvaTextFontFamily,
    lineHeight: FIELD_DEFAULT_LINE_HEIGHT,
    letterSpacing: FIELD_DEFAULT_LETTER_SPACING,
    textAlign: 'center',
    verticalAlign: FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN,
    baseX: DEFAULT_TEXT_X_PADDING,
    baseY: 0,
    baseWidth: fieldWidth - DEFAULT_TEXT_X_PADDING * 2,
    baseHeight: fieldHeight,
    groupX: fieldGroup.x(),
    groupY: fieldGroup.y(),
    pageWidth,
    pageHeight,
  });

  const fieldText = new Konva.Text({
    id: `${field.renderId}-text`,
    name: 'field-text',
    x: overflowLayout.x,
    y: overflowLayout.y,
    verticalAlign: overflowLayout.verticalAlign,
    wrap: overflowLayout.wrap,
    text: textToRender,
    fontSize,
    align: overflowLayout.textAlign,
    fontFamily: konvaTextFontFamily,
    fill: konvaTextFill,
    width: overflowLayout.width,
    height: overflowLayout.height,
  } satisfies Partial<Konva.TextConfig>);

  fieldGroup.add(fieldRect);
  fieldGroup.add(fieldText);

  fieldGroup.on('transform', () => {
    const groupScaleX = fieldGroup.scaleX();
    const groupScaleY = fieldGroup.scaleY();

    fieldText.scaleX(1 / groupScaleX);
    fieldText.scaleY(1 / groupScaleY);

    const rectWidth = fieldRect.width() * groupScaleX;
    const rectHeight = fieldRect.height() * groupScaleY;

    fieldText.x(DEFAULT_TEXT_X_PADDING);
    fieldText.y(0);
    fieldText.width(rectWidth - DEFAULT_TEXT_X_PADDING * 2);
    fieldText.height(rectHeight);
    fieldText.wrap('word');

    fieldGroup.getLayer()?.batchDraw();
  });

  // Handle export mode.
  if (mode === 'export') {
    fieldRect.opacity(0);
  }

  if (color !== 'readOnly' && mode !== 'export') {
    createFieldHoverInteraction({ fieldGroup, fieldRect, options });
  }

  return {
    fieldGroup,
    isFirstRender,
  };
};
