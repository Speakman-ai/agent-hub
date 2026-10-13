/**
 * Google Chat attachment viewer, in a real browser.
 *
 * The jsdom unit tests cannot tell whether keyboard events typed into the PDF
 * reach the dialog: that depends on the PDF living in the page's own document
 * rather than a nested one. Here pdf.js renders a real PDF and the keyboard
 * goes through Chromium, so Escape typed after clicking into the PDF is the
 * real path. Only the attachment content request is mocked (page.route()).
 *
 * The component is mounted through client/src/e2e-harness rather than the
 * Google Chat pane so the spec does not depend on sign-in or Google setup.
 */

import { test, expect } from '../fixtures.js';
import type { Page } from '@playwright/test';

const ATTACHMENT = {
  id: 'ATT1',
  contentName: 'spec.pdf',
  contentType: 'application/pdf',
  source: 'UPLOADED_CONTENT',
  downloadable: true,
  driveUrl: null,
};

/** Portrait page 1, landscape page 2; pdf.js rebuilds the xref, so offsets need not be exact. */
function mixedOrientationPdf(): Buffer {
  const stream = 'BT /F1 24 Tf 72 720 Td (Hello PDF) Tj ET';
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      `4 0 obj << /Length ${stream.length} >> stream`,
      stream,
      'endstream endobj',
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      '6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n'),
  );
}

/** 32x32 solid red (220, 20, 20) JPEG2000 image, made with Pillow. */
const RED_JP2 =
  'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAIAAAACAAAwcHAAAAAAAPY29scgEAAAAAABAAAACzanAyY/9P/1EALwAAAAAAIAAAACAAAAAAAAAAAAAAACAAAAAgAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAUEBAAB/1wAE0BASEhQSEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAALAAB/5PPtAgDM8+0CAgfz7QICB+AgICAgICAgICAgICAgID/2Q==';

/** One page filled by a JPEG2000 image; pdf.js decodes JPXDecode with OpenJPEG. */
function jpeg2000Pdf(): Buffer {
  const image = Buffer.from(RED_JP2, 'base64');
  const content = 'q 200 0 0 200 0 0 cm /Im1 Do Q';
  return Buffer.concat([
    Buffer.from(
      [
        '%PDF-1.5',
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
        '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >> endobj',
        `4 0 obj << /Length ${content.length} >> stream`,
        content,
        'endstream endobj',
        `5 0 obj << /Type /XObject /Subtype /Image /Width 32 /Height 32 /Filter /JPXDecode /Length ${image.length} >> stream`,
        '',
      ].join('\n'),
    ),
    image,
    Buffer.from(['', 'endstream endobj', 'trailer << /Root 1 0 R >>', '%%EOF'].join('\n')),
  ]);
}

/**
 * Serves `pdf` as the attachment bytes (octet-stream, as the Hub does), then
 * loads the Vite origin and detaches the app shell so its sign-in screen
 * cannot steal focus. A plain button stands in for background content.
 */
async function mountAttachment(page: Page, pdf: Buffer) {
  await page.route('**/api/google/chat/spaces/AAA/messages/M1/attachments/ATT1/content', (route) =>
    route.fulfill({ body: pdf, contentType: 'application/octet-stream' }),
  );
  await page.goto('/');
  await page.evaluate(async (attachment) => {
    document.getElementById('root')?.remove();
    const bg = document.createElement('button');
    bg.id = 'background';
    bg.textContent = 'background';
    document.body.appendChild(bg);
    const harness = '/src/e2e-harness/googleChatAttachments.tsx';
    const mod = await import(/* @vite-ignore */ harness);
    mod.mount([attachment]);
  }, ATTACHMENT);
}

test.describe('Google Chat attachment viewer', () => {
  test('Escape closes the PDF viewer after focus moves into the PDF', async ({ page }) => {
    test.setTimeout(45_000);

    await mountAttachment(page, mixedOrientationPdf());

    const chip = page.getByRole('button', { name: 'spec.pdf', exact: true });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'spec.pdf' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(page.locator('#background')).toHaveAttribute('inert', '');

    // Wait for pdf.js to paint, then put focus in the PDF the way a user would.
    const pdf = dialog.getByRole('document', { name: 'spec.pdf' });
    const canvas = pdf.locator('canvas[data-page="1"]');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(await page.locator('iframe, embed, object').count()).toBe(0);

    // Each page keeps its own proportions once drawn.
    const landscape = pdf.locator('canvas[data-page="2"]');
    await landscape.scrollIntoViewIfNeeded();
    await expect
      .poll(() => landscape.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 })
      .toBeGreaterThan(0);
    const shape = async (c: typeof canvas) => {
      const box = await c.boundingBox();
      return box ? box.width / box.height : 0;
    };
    expect(await shape(canvas)).toBeCloseTo(612 / 792, 2);
    expect(await shape(landscape)).toBeCloseTo(792 / 612, 2);
    await canvas.click();
    await expect(pdf).toBeFocused();

    // Tab stays inside the dialog.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }

    await canvas.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(chip).toBeFocused();
    await expect(page.locator('#background')).not.toHaveAttribute('inert');
  });

  test('decodes JPEG2000 images with the shipped OpenJPEG decoder', async ({ page }) => {
    test.setTimeout(45_000);
    await mountAttachment(page, jpeg2000Pdf());
    await page.getByRole('button', { name: 'spec.pdf', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'spec.pdf' });
    const canvas = dialog.locator('canvas[data-page="1"]');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('alert')).toHaveCount(0);

    // Without the decoder the image is dropped and the page stays white.
    const centre = () =>
      canvas.evaluate((c: HTMLCanvasElement) => {
        if (c.width === 0) return 'blank';
        const [r, g, b] = c.getContext('2d')!.getImageData(c.width / 2, c.height / 2, 1, 1).data;
        return r > 180 && g < 70 && b < 70 ? 'red' : `rgb(${r}, ${g}, ${b})`;
      });
    await expect.poll(centre, { timeout: 15_000 }).toBe('red');
  });
});
