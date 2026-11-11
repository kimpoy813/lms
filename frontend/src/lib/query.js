import { QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '../components/toast.jsx';
import { ApiError, errorMessage } from './api.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      // Retrying "not found" or "not allowed" only delays the message.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

/**
 * A mutation with the app's defaults: an error toast (unless the form shows field errors itself),
 * an optional success toast, and cache invalidation.
 *   const save = useAction((body) => api.post('/tasks', body), { invalidate: [['tasks']], success: 'Task added' });
 */
export function useAction(fn, { invalidate = [], success, onSuccess, onError, silent = false } = {}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data, variables) => {
      await Promise.all(invalidate.map((queryKey) => client.invalidateQueries({ queryKey })));
      if (success) toast.success(typeof success === 'function' ? success(data, variables) : success);
      onSuccess?.(data, variables);
    },
    onError: (err, variables) => {
      const handled = onError?.(err, variables);
      if (!silent && handled !== true && !(err instanceof ApiError && err.fields && onError)) toast.error(errorMessage(err));
    },
  });
}
