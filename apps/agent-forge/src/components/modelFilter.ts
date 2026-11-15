import type { CatalogModel } from '../../shared/wireTypes';

type LabelledModel = Pick<CatalogModel, 'id' | 'available' | 'inputCostPerMTok' | 'outputCostPerMTok'>;

export function modelLabel(m: LabelledModel): string {
  const free = m.inputCostPerMTok === 0 && m.outputCostPerMTok === 0;
  return `${m.id}${free ? ' (free)' : ''}${m.available ? '' : ' (no key)'}`;
}

export function matchesModelFilter(label: string, query: string): boolean {
  const text = label.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}
