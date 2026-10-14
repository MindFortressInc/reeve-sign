/**
 * SES reads this header off messages sent through its SMTP relay and applies
 * the named configuration set, which is what routes bounce/complaint events to
 * an event destination. SES strips it before delivery.
 */
export const SES_CONFIGURATION_SET_HEADER = 'X-SES-CONFIGURATION-SET';

/**
 * Nodemailer transport defaults that tag every message with an SES
 * configuration set. Returns `undefined` (no defaults, behaviour unchanged)
 * when the value is unset or blank.
 *
 * Nodemailer merges default headers per key, so a message that sets its own
 * `headers` still carries this one.
 */
export const getSesConfigurationSetDefaults = (configurationSet: string | undefined) => {
  const value = configurationSet?.trim();

  return value ? { headers: { [SES_CONFIGURATION_SET_HEADER]: value } } : undefined;
};
