import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabasePublicKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
    supabasePublicKey &&
    !supabaseUrl.includes('YOUR_PROJECT_REF') &&
    !supabasePublicKey.includes('YOUR_SUPABASE_PUBLIC_ANON_KEY') &&
    !supabasePublicKey.includes('YOUR_SUPABASE_PUBLISHABLE_KEY')
);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabasePublicKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : null;

export function getOAuthRedirectUrl(): string {
  const configured = import.meta.env.VITE_AUTH_REDIRECT_URL as string | undefined;
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }
  return window.location.origin;
}
