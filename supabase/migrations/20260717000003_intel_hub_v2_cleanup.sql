-- Intelligence Hub v2 redesign: the PESTEL (quarterly) and Market Architecture
-- (yearly) segments were removed from the product. Delete their stored reports
-- and any feedback/learning rows tied to them so they cannot resurface.
-- Guarded with to_regclass because intel_hub_feedback / intel_hub_learning were
-- created directly in production (they are not in this migrations history).

do $$
begin
  if to_regclass('public.intelligence_hub_reports') is not null then
    delete from public.intelligence_hub_reports
      where section_key in ('pestel', 'market_architecture');
  end if;

  if to_regclass('public.intel_hub_feedback') is not null then
    delete from public.intel_hub_feedback
      where section_key in ('pestel', 'market_architecture');
  end if;

  if to_regclass('public.intel_hub_learning') is not null then
    delete from public.intel_hub_learning
      where section_key in ('pestel', 'market_architecture');
  end if;
end $$;
