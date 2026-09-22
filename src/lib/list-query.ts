import { z } from 'zod';
import { ApiError } from './api-error.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(50).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
}).passthrough();

export type ListQuery = {
  page: number;
  pageSize: number;
  search: string | undefined;
  sort: string;
  order: 'asc' | 'desc';
  offset: number;
};

export function parseListQuery(
  query: unknown,
  allowedSorts: readonly string[],
  defaultSort = 'createdAt',
): ListQuery {
  const result = listQuerySchema.safeParse(query);
  if (!result.success) throw result.error;

  const sort = result.data.sort ?? defaultSort;
  if (!allowedSorts.includes(sort)) {
    throw new ApiError(400, 'SORT_NOT_ALLOWED', 'Sort field is not allowed', { sort });
  }

  const pageSize = result.data.pageSize ?? result.data.limit ?? 10;
  return {
    page: result.data.page,
    pageSize,
    search: result.data.search,
    sort,
    order: result.data.order,
    offset: (result.data.page - 1) * pageSize,
  };
}

export function pagination(total: number, query: ListQuery) {
  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    limit: query.pageSize,
    totalPages: Math.ceil(total / query.pageSize),
  };
}
