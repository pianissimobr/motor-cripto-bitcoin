/**
 * Escopo da alocacao de indices HD.
 *
 * O endereco derivado depende apenas do indice, nao do perfil Ramp. Antes a
 * alocacao era por `profile.id`, entao dois perfis alocavam indice 0 e
 * derivavam o MESMO endereco (violando o unique de `links_gerados`).
 *
 * Por isso a alocacao e global: um unico contador para toda a carteira.
 */
export const HD_INDEX_SCOPE = 'hd';
