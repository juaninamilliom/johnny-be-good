export interface User {
  id: string;
  name: string;
  manager?: { id: string; name: string };
}

const users = new Map<string, User>();

export function addUser(u: User): void {
  users.set(u.id, u);
}

export function managerName(id: string): string {
  const user = users.get(id);
  return user?.manager?.name ?? "none";
}
