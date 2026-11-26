import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrfToken } from './api.js';

let originalCreateObjectURL;

describe('API file downloads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
    else delete URL.createObjectURL;
    originalCreateObjectURL = null;
    setCsrfToken(null);
  });

  it('posts a template with the session CSRF token and saves the returned file name', async () => {
    const file = new File(['template'], 'grades.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const response = new Response('filled document', {
      headers: { 'Content-Disposition': 'attachment; filename="grades-filled-grades.docx"' },
    });
    const fetch = vi.fn().mockResolvedValue(response);
    const createObjectURL = vi.fn().mockReturnValue('blob:filled-template');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('setTimeout', vi.fn());
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    setCsrfToken('test-csrf');

    const name = await api.downloadForm(
      '/classes/class-1/gradebook/export-template',
      { file },
      { by: 'weights', periodId: 'period-1' },
      'fallback.docx',
    );

    expect(name).toBe('grades-filled-grades.docx');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/classes/class-1/gradebook/export-template?by=weights&periodId=period-1');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({ Accept: 'application/json', 'X-CSRF-Token': 'test-csrf' });
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('file')).toBeInstanceOf(File);
    expect(options.body.get('file').name).toBe(file.name);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0].size).toBe(15);
    expect(click).toHaveBeenCalledOnce();
  });
});
