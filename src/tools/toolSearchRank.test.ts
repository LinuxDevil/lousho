import { describe, expect, it } from 'vitest';
import { rankToolsByKeywords, searchWords } from './toolSearchRank';

const tools = [
  { name: 'convert_currency', description: 'Convert an amount of money from one currency to another' },
  { name: 'exchange_rates', description: 'List currency exchange rates' },
  { name: 'get_weather', description: 'Get the weather forecast for a city' },
  { name: 'github__create_issue', description: 'Open an issue in a repository' },
  { name: 'lookupStock', description: 'Look up a stock price' },
];

describe('rankToolsByKeywords', () => {

  it('splits names on _, -, __ and camelCase', () => {
    expect(rankToolsByKeywords('github issue', tools)).toEqual(['github__create_issue']);
    expect(rankToolsByKeywords('stock', tools)).toEqual(['lookupStock']);
    expect(searchWords('x-b__c_dE')).toEqual(['x', 'b', 'c', 'd', 'e']);
    expect(searchWords('What are the currencies for tools?')).toEqual(['currency', 'tool']);
  });

  it('finds tools by a synonym or a word of the same family', () => {
    const more = [
      { name: 'fetch_equity_quote', description: 'Latest trade for a ticker' },
      { name: 'job_status', description: 'Report a job' },
      { name: 'get_weather', description: 'Get the weather forecast for a city' },
      { name: 'convert_currency', description: 'Convert an amount of money' },
    ];
    expect(rankToolsByKeywords('share value', more)).toEqual(['fetch_equity_quote']);
    expect(rankToolsByKeywords('statuses', more)).toEqual(['job_status']);
    expect(searchWords('statuses boxes addresses analysis uses')).toEqual(['status', 'box', 'address', 'analysis', 'use']);
    expect(rankToolsByKeywords('converting', more)).toEqual(['convert_currency']);
    expect(rankToolsByKeywords('current', [{ name: 'convert_currency', description: 'Currency' }])).toEqual([]);
    expect(rankToolsByKeywords('retrieve forecast', more)[0]).toBe('get_weather');
  });

  it('orders ties by name and leaves out tools with no shared word', () => {
    const tied = [
      { name: 'b_tool', description: 'search' },
      { name: 'a_tool', description: 'search' },
      { name: 'c_other', description: 'nothing' },
    ];
    expect(rankToolsByKeywords('search', tied)).toEqual(['a_tool', 'b_tool']);
    expect(rankToolsByKeywords('', tied)).toEqual([]);
    expect(rankToolsByKeywords('?!', tied)).toEqual([]);
  });
});
