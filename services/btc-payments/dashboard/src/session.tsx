import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';

export type Merchant = { id: string; name: string; role: string; status: string };
export type Me = { user: { id: string; email: string; status: string }; merchants: Merchant[] };

type SessionValue = {
  me: Me | null;
  loading: boolean;
  merchant: Merchant | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
  const me = query.data ?? null;
  const value: SessionValue = {
    me,
    loading: query.isLoading,
    // Uma loja por conta por enquanto: a primeira.
    merchant: me?.merchants[0] ?? null,
    refresh: async () => {
      await client.invalidateQueries({ queryKey: ['me'] });
    },
    logout: async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      client.clear();
      client.setQueryData(['me'], null);
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession fora do SessionProvider');
  return value;
}

/** Id da loja atual (as paginas internas so renderizam com sessao). */
export function useMerchantId(): string {
  const { merchant } = useSession();
  if (!merchant) throw new Error('sem loja');
  return merchant.id;
}
