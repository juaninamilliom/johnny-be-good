export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
}

/** Splits items into pages of `size`. Pages are numbered from 1. */
export function paginate<T>(items: T[], page: number, size: number): Page<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(page, 1), totalPages);
  const start = current * size;
  return { items: items.slice(start, start + size), page: current, totalPages };
}
