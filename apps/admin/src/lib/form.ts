/** Reads a text field from FormData (files and missing fields become ""). */
export function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}
