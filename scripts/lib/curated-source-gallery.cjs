// Sinovcle's primary product-description gallery is more specific than its cover.
module.exports = function preferProductDescriptionGallery(verified, original, html, integrity, checkedAt) {
  if (!/^(?:https?:\/\/)?(?:www\.)?sinovcleglobal\.com\/product\//i.test(integrity.sourceUrl(original))
      || !verified.result.matched || verified.result.identityIssue) return verified;
  if (verified.result.sourceTitle && integrity.identityText(verified.result.sourceTitle) !== integrity.identityText(original.title)) return verified;
  const stack = [], images = [];
  const source = String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  for (const token of source.matchAll(/<(\/?)([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const closing = token[1], tag = token[2].toLowerCase(), attributes = token[3];
    if (closing) {
      const index = stack.map(node => node.tag).lastIndexOf(tag);
      if (index >= 0) stack.length = index;
      continue;
    }
    const classes = (attributes.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '').split(/\s+/);
    const parent = stack.at(-1) || {};
    const features = parent.features || classes.includes('features-tab');
    const active = parent.active || (classes.includes('tab-pane') && classes.includes('active'));
    if (tag === 'img' && features && active) {
      const src = attributes.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1] || '';
      const image = integrity.normalizeImage(src, integrity.sourceUrl(original));
      if (image && /\/storage\/uploads\/images\//.test(image)) images.push(image);
    }
    if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag) && !/\/\s*$/.test(attributes)) stack.push({ tag, features, active });
  }
  const gallery = [...new Set(images)].slice(0, 4);
  if (!gallery.length) return verified;
  let attributes; try { attributes = JSON.parse(verified.row.attributes || '{}'); } catch { attributes = {}; }
  const proof = { ...(attributes.listingIdentity || {}), version: integrity.VERSION, sourceUrl: integrity.sourceUrl(original), title: original.title, images: gallery, checkedAt };
  const row = { ...verified.row, image_urls: gallery.join('|'), image_files: '', attributes: JSON.stringify({ ...attributes, listingIdentity: proof, sourceGallerySelector: '.features-tab .tab-pane.active img', imageSourceUrl: integrity.sourceUrl(original), imageVerifiedAt: checkedAt, imageIntegrityVersion: integrity.VERSION }) };
  return { row, result: { ...verified.result, images: gallery, method: 'primary_product_description_gallery', identityIssue: integrity.publicationIssue(row) } };
};
