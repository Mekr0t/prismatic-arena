-- 0022_super_region.sql
-- Fold platform codes into super-regions in the tables that OUTLIVE a rollup.
--
-- The crawl now seeds every EMEA platform (euw1, eun1, tr1, ru, me1) rather than
-- EUW alone, and the rollup pools them into one 'EMEA' bucket: the game's rules
-- are identical everywhere, only playstyle and field strength differ, so a
-- per-platform tier list fragments one meta into shards that each have too
-- little sample to say anything.
--
-- comp_stats and bucket_totals are rebuilt from scratch every rollup, so they
-- need nothing here. comp_stat_trends does NOT — it accumulates one row per
-- (comp, patch, region, bucket, snapshot_date) and is only cleared for TODAY.
-- Left alone, every comp's trend line would stop dead at 'EUW1' and restart
-- under 'EMEA', which reads as "this comp appeared yesterday" for the entire
-- tier list. tier_list_entries keeps manual pins keyed the same way, and those
-- would silently stop matching the rows they pin.
--
-- Every existing row is EUW1 (1,974,652 trend rows at the time of writing) and
-- EUW1 *is* EMEA, so this is a lossless rename rather than a merge. The generic
-- form is written anyway, because the next platform added must not need a second
-- migration.

UPDATE comp_stat_trends SET region = CASE upper(region)
    WHEN 'NA1' THEN 'AMER' WHEN 'BR1'  THEN 'AMER' WHEN 'LA1' THEN 'AMER' WHEN 'LA2' THEN 'AMER'
    WHEN 'EUW1' THEN 'EMEA' WHEN 'EUN1' THEN 'EMEA' WHEN 'TR1' THEN 'EMEA'
    WHEN 'RU'  THEN 'EMEA' WHEN 'ME1'  THEN 'EMEA'
    WHEN 'KR'  THEN 'APAC' WHEN 'JP1'  THEN 'APAC' WHEN 'OC1' THEN 'APAC'
    WHEN 'PH2' THEN 'APAC' WHEN 'SG2'  THEN 'APAC' WHEN 'TH2' THEN 'APAC'
    WHEN 'TW2' THEN 'APAC' WHEN 'VN2'  THEN 'APAC'
    ELSE region
  END
 WHERE upper(region) IN ('NA1','BR1','LA1','LA2','EUW1','EUN1','TR1','RU','ME1',
                         'KR','JP1','OC1','PH2','SG2','TH2','TW2','VN2');

UPDATE tier_list_entries SET region = CASE upper(region)
    WHEN 'NA1' THEN 'AMER' WHEN 'BR1'  THEN 'AMER' WHEN 'LA1' THEN 'AMER' WHEN 'LA2' THEN 'AMER'
    WHEN 'EUW1' THEN 'EMEA' WHEN 'EUN1' THEN 'EMEA' WHEN 'TR1' THEN 'EMEA'
    WHEN 'RU'  THEN 'EMEA' WHEN 'ME1'  THEN 'EMEA'
    WHEN 'KR'  THEN 'APAC' WHEN 'JP1'  THEN 'APAC' WHEN 'OC1' THEN 'APAC'
    WHEN 'PH2' THEN 'APAC' WHEN 'SG2'  THEN 'APAC' WHEN 'TH2' THEN 'APAC'
    WHEN 'TW2' THEN 'APAC' WHEN 'VN2'  THEN 'APAC'
    ELSE region
  END
 WHERE upper(region) IN ('NA1','BR1','LA1','LA2','EUW1','EUN1','TR1','RU','ME1',
                         'KR','JP1','OC1','PH2','SG2','TH2','TW2','VN2');
