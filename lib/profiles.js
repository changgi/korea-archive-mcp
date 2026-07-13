// profiles — per-institution 3-layer profiles aggregator.
// Each institution lives in its own lib/profile_<key>.js; this file re-exports them as PROFILES for the source_profile tool.
import { PROFILE as tna } from './profile_tna.js';
import { PROFILE as nara } from './profile_nara.js';
import { PROFILE as ia } from './profile_ia.js';
import { PROFILE as gallica } from './profile_gallica.js';
import { PROFILE as europeana } from './profile_europeana.js';
import { PROFILE as nedb } from './profile_nedb.js';
import { PROFILE as archives } from './profile_archives.js';
import { PROFILE as nlk } from './profile_nlk.js';
import { PROFILE as seoul } from './profile_seoul.js';
import { PROFILE as warmemo } from './profile_warmemo.js';
import { PROFILE as foia } from './profile_foia.js';
export const PROFILES = {
  tna,
  nara,
  ia,
  gallica,
  europeana,
  nedb,
  archives,
  nlk,
  seoul,
  warmemo,
  foia,
};
