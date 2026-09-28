import { expect, it } from 'vitest';
import { providerForUrl, sameUpstreamOrigin, validLocalEndpoint } from '../web/src/lib/upstream-provider-catalog.js';

it('recognizes preset providers and private endpoint shapes', () => {
  expect(providerForUrl('https://api.deepseek.com/v1')).toBe('deepseek');
  expect(providerForUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe('gemini');
  expect(providerForUrl('http://model.lan:11434/v1')).toBe('local');
  expect(validLocalEndpoint('http://192.168.1.20:11434/v1')).toBe(true);
  expect(validLocalEndpoint('https://model.lan/v1')).toBe(true);
  expect(validLocalEndpoint('http://model.lan/v1')).toBe(false);
  expect(validLocalEndpoint('http://localhost:11434/v1')).toBe(false);
  expect(validLocalEndpoint('http://user:secret@model.lan:11434/v1')).toBe(false);
});

it('only considers a stored key reusable on the same origin', () => {
  expect(sameUpstreamOrigin('https://api.openai.com/v1', 'https://api.openai.com/v2')).toBe(true);
  expect(sameUpstreamOrigin('https://api.openai.com/v1', 'https://api.anthropic.com/v1')).toBe(false);
  expect(sameUpstreamOrigin('http://192.168.1.20:11434/v1', 'http://192.168.1.20:8000/v1')).toBe(false);
});
