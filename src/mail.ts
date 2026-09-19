export function rawKey(inbox: string, id: string): string {
  return `${inbox}/${id}.eml`;
}
