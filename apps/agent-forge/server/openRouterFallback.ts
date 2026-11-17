export function openRouterModelId(provider: string, modelId: string): string {
  const id = provider === 'anthropic' ? modelId.replace(/-(\d+)-(\d+)$/, '-$1.$2') : modelId;
  return `${provider}/${id}`;
}
