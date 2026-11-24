-- Bingo v6: le funzioni dei controlli automatici non si chiamano da fuori
revoke execute on function public.controlla_pronostici() from public, anon, authenticated;
revoke execute on function public.blocca_a_serata_finita() from public, anon, authenticated;
