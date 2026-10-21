/**
 * The org setting that turns the code index on. Off unless an admin turns it on. The same rule as
 * `codeIndexEnabled` in @autodev/code-index, kept here so the API doesn't load the model and parsers.
 */
export function codeIndexEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.storeCodeIndex === true;
}
