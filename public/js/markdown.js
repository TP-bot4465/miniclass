/**
 * Escape raw HTML characters to prevent injection of <script>, <iframe>, on* handlers (SES-06, AC-05, NFR-10).
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate URL to block javascript:, vbscript:, data:text/html, etc.
 */
export function sanitizeUrl(url, allowImage = false) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '#';
  const lower = trimmed.toLowerCase().replace(/\s+/g, '');
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('data:text/') ||
    lower.startsWith('file:')
  ) {
    return '#blocked';
  }
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('/api/files/') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('#')
  ) {
    return escapeHtml(trimmed);
  }
  if (allowImage && /^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-zA-Z0-9+/=]+$/i.test(trimmed)) {
    return trimmed;
  }
  return '#blocked';
}

/**
 * Lightweight syntax highlighter for code blocks & GRD-04 file preview.
 * Strictly escapes HTML first so embedded <script> or HTML tags inside code never execute (AC-15).
 */
export function highlightCode(rawCode, lang = '') {
  const escaped = escapeHtml(rawCode);
  const language = String(lang || '').toLowerCase();

  if (!language || language === 'txt' || language === 'md') {
    return escaped;
  }

  // Highlight comments, strings, numbers, and common keywords safely using token placeholders
  const tokens = [];
  const putToken = (cls, text) => {
    const idx = tokens.length;
    tokens.push(`<span class="hl-${cls}">${text}</span>`);
    return `\u0000TOK${idx}\u0000`;
  };

  let work = escaped;

  // Comments (# for python, // for js/c/cpp/java)
  if (['py', 'python'].includes(language)) {
    work = work.replace(/(#[^\n]*)/g, (_, m) => putToken('comment', m));
  } else if (['js', 'javascript', 'java', 'c', 'cpp', 'css'].includes(language)) {
    work = work.replace(/(\/\/[^\n]*)/g, (_, m) => putToken('comment', m));
  }

  // Strings (&quot;...&quot; or &#39;...&#39;)
  work = work.replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, (_, m) => putToken('string', m));

  // Keywords
  const kwPattern =
    /\b(def|class|return|if|elif|else|for|while|in|import|from|as|try|except|finally|with|True|False|None|and|or|not|function|const|let|var|async|await|public|private|static|void|int|float|double|string|boolean|struct|include)\b/g;
  work = work.replace(kwPattern, (_, m) => putToken('keyword', m));

  // Numbers
  work = work.replace(/\b(\d+(?:\.\d+)?)\b/g, (_, m) => putToken('number', m));

  // Restore tokens
  return work.replace(/\u0000TOK(\d+)\u0000/g, (_, idx) => tokens[Number(idx)] || '');
}

/**
 * Parse inline Markdown formatting on already-escaped text.
 */
function parseInlineMarkdown(rawText) {
  // Strip any raw <script>...</script>, <iframe>...</iframe>, <style>...</style> blocks completely before escaping
  const cleaned = String(rawText || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '');

  // Extract inline code spans first so their content isn't parsed as bold/italic
  const codeSpans = [];
  let text = cleaned.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  // Extract images ![alt](url)
  const mediaSpans = [];
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const idx = mediaSpans.length;
    const safeAlt = escapeHtml(alt || 'Hình minh họa bài giảng');
    const safeUrl = sanitizeUrl(url, true);
    mediaSpans.push(`<img src="${safeUrl}" alt="${safeAlt}" class="md-image" loading="lazy" />`);
    return `\u0000MEDIA${idx}\u0000`;
  });

  // Extract links [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const idx = mediaSpans.length;
    const safeLabel = escapeHtml(label);
    const safeUrl = sanitizeUrl(url, false);
    mediaSpans.push(
      `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`
    );
    return `\u0000MEDIA${idx}\u0000`;
  });

  // Escape any remaining HTML tags/attributes
  text = escapeHtml(text);

  // Bold **text**
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic *text*
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // Strikethrough ~~text~~
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Restore media & code spans
  text = text.replace(/\u0000MEDIA(\d+)\u0000/g, (_, idx) => mediaSpans[Number(idx)] || '');
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeSpans[Number(idx)] || '');

  return text;
}

/**
 * DOM-level sanitizer (DOMPurify equivalent) when running in browser.
 * Guarantees zero <script>, <iframe>, <object>, or on* event handlers survive (SES-06, AC-05, NFR-10).
 */
const ALLOWED_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'P', 'BR', 'HR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE',
  'UL', 'OL', 'LI', 'BLOCKQUOTE',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  'A', 'IMG', 'DIV', 'SPAN'
]);

const ALLOWED_ATTRS = {
  A: new Set(['href', 'target', 'rel']),
  IMG: new Set(['src', 'alt', 'class', 'loading']),
  TH: new Set(['style']),
  TD: new Set(['style']),
  SPAN: new Set(['class']),
  PRE: new Set(['class']),
  CODE: new Set(['class']),
  DIV: new Set(['class'])
};

export function sanitizeRenderedHtml(htmlString) {
  if (typeof DOMParser === 'undefined') {
    return htmlString;
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${htmlString}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';

  const cleanNode = (node) => {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === 1) {
        const tag = child.tagName.toUpperCase();
        if (!ALLOWED_TAGS.has(tag)) {
          child.remove();
          continue;
        }
        const allowedForTag = ALLOWED_ATTRS[tag] || new Set();
        for (const attr of Array.from(child.attributes)) {
          const name = attr.name.toLowerCase();
          const val = attr.value || '';
          if (name.startsWith('on') || !allowedForTag.has(name)) {
            child.removeAttribute(attr.name);
            continue;
          }
          if ((name === 'href' || name === 'src') && /^\s*(javascript|vbscript|data:text)/i.test(val)) {
            child.setAttribute(name, '#blocked');
          }
          if (name === 'style' && !/^text-align:\s*(left|center|right);?$/i.test(val.trim())) {
            child.removeAttribute('style');
          }
        }
        cleanNode(child);
      } else if (child.nodeType === 8) {
        // Remove HTML comments
        child.remove();
      }
    }
  };

  cleanNode(root);
  return root.innerHTML;
}

/**
 * Render Markdown text into safe, formatted HTML (SES-02, SES-05, SES-06, AC-04, AC-05).
 */
export function renderMarkdown(markdownText) {
  if (!markdownText) return '';

  // Remove dangerous script/iframe blocks upfront
  const cleanSource = String(markdownText)
    .replace(/\r\n/g, '\n')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');

  const lines = cleanSource.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Fenced code block ```lang
    const fenceMatch = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const highlighted = highlightCode(codeLines.join('\n'), lang);
      const langBadge = lang ? `<div class="code-lang-header">${escapeHtml(lang)}</div>` : '';
      out.push(`<div class="md-code-block">${langBadge}<pre><code>${highlighted}</code></pre></div>`);
      continue;
    }

    // 2. Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      out.push('<hr />');
      i++;
      continue;
    }

    // 3. Heading # .. ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${parseInlineMarkdown(headingMatch[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // 4. Table | col1 | col2 |
    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[i + 1])
    ) {
      const parseTableRow = (rowStr) =>
        rowStr
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());

      const headers = parseTableRow(line);
      const aligns = parseTableRow(lines[i + 1]).map((a) => {
        if (a.startsWith(':') && a.endsWith(':')) return 'center';
        if (a.endsWith(':')) return 'right';
        return 'left';
      });

      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        bodyRows.push(parseTableRow(lines[i]));
        i++;
      }

      const thHtml = headers
        .map((h, idx) => `<th style="text-align:${aligns[idx] || 'left'}">${parseInlineMarkdown(h)}</th>`)
        .join('');
      const tbHtml = bodyRows
        .map(
          (row) =>
            `<tr>${headers
              .map(
                (_, idx) =>
                  `<td style="text-align:${aligns[idx] || 'left'}">${parseInlineMarkdown(row[idx] || '')}</td>`
              )
              .join('')}</tr>`
        )
        .join('');

      out.push(`<div class="md-table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbHtml}</tbody></table></div>`);
      continue;
    }

    // 5. Blockquote >
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${quoteLines.map(parseInlineMarkdown).join('<br />')}</blockquote>`);
      continue;
    }

    // 6. Unordered list (- or *)
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${parseInlineMarkdown(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // 7. Ordered list (1. 2.)
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${parseInlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // 8. Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // 9. Paragraph
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+\.\s|\s*>|\|)/.test(lines[i])
    ) {
      paraLines.push(parseInlineMarkdown(lines[i]));
      i++;
    }
    if (paraLines.length > 0) {
      out.push(`<p>${paraLines.join('<br />')}</p>`);
    } else {
      out.push(`<p>${parseInlineMarkdown(lines[i])}</p>`);
      i++;
    }
  }

  return sanitizeRenderedHtml(out.join('\n'));
}
