export type ImageSize = 'small' | 'medium' | 'full';
export type ImageAlignment = 'left' | 'center' | 'right';

export type ImageOptions = {
  size: ImageSize;
  alignment: ImageAlignment;
  wrap: boolean;
  caption: string;
};

export const defaultImageOptions: ImageOptions = {
  size: 'medium',
  alignment: 'center',
  wrap: false,
  caption: '',
};

export function createChecklistItem(): HTMLDivElement {
  const id = crypto.randomUUID();
  const row = document.createElement('div');
  row.dataset.checkItem = '';
  row.dataset.checkId = id;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.setAttribute('aria-label', 'Mark checklist item complete');
  checkbox.dataset.testid = `checkbox-check-item-${id}`;

  const text = document.createElement('span');
  text.dataset.checkText = '';
  text.contentEditable = 'true';
  text.innerHTML = '<br>';

  row.append(checkbox, text);
  return row;
}

export function migrateLegacyChecklistItems(editor: HTMLElement): boolean {
  const oldItems = Array.from(editor.querySelectorAll<HTMLLIElement>('li[data-check-item]'));
  for (const oldItem of oldItems) {
    const row = createChecklistItem();
    const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const oldCheckbox = oldItem.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (oldCheckbox?.hasAttribute('checked')) checkbox.setAttribute('checked', '');

    const text = row.querySelector<HTMLElement>('[data-check-text]')!;
    for (const child of Array.from(oldItem.childNodes)) {
      if (child !== oldCheckbox) text.append(child);
    }
    if (!text.textContent?.trim() && !text.querySelector('img, br')) text.innerHTML = '<br>';

    const list = oldItem.parentElement;
    oldItem.replaceWith(row);
    if (list?.tagName === 'UL' && Array.from(list.children).every(child => child.hasAttribute('data-check-item'))) {
      list.replaceWith(...Array.from(list.children));
    }
  }
  return oldItems.length > 0;
}

export function createImageFigure(
  image: HTMLImageElement,
  options: ImageOptions = defaultImageOptions,
): HTMLElement {
  const figure = document.createElement('figure');
  const id = crypto.randomUUID();
  figure.dataset.noteImage = '';
  figure.dataset.imageId = id;
  figure.dataset.testid = `figure-note-image-${id}`;
  figure.dataset.size = options.size;
  figure.dataset.align = options.alignment;
  figure.dataset.wrap = String(options.wrap);

  const caption = document.createElement('figcaption');
  caption.dataset.imageCaption = '';
  caption.contentEditable = 'true';
  caption.dataset.placeholder = 'Add a caption';
  caption.textContent = options.caption;

  figure.append(image, caption);
  return figure;
}

function fragmentHasContent(fragment: DocumentFragment): boolean {
  return Boolean(fragment.textContent?.trim() || fragment.querySelector('img, input, br'));
}

export function migrateLegacyImages(editor: HTMLElement): boolean {
  const images = Array.from(editor.querySelectorAll<HTMLImageElement>('img'))
    .filter(image => !image.closest('figure[data-note-image]'));
  for (const image of images) {
    const paragraph = image.closest('p');
    if (!paragraph || !editor.contains(paragraph)) {
      const parent = image.parentNode;
      const nextSibling = image.nextSibling;
      const figure = createImageFigure(image);
      if (parent) parent.insertBefore(figure, nextSibling);
      continue;
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(paragraph);
    beforeRange.setEndBefore(image);
    const before = beforeRange.cloneContents();

    const afterRange = document.createRange();
    afterRange.selectNodeContents(paragraph);
    afterRange.setStartAfter(image);
    const after = afterRange.cloneContents();

    const figure = createImageFigure(image);
    const nodes: Node[] = [];
    if (fragmentHasContent(before)) {
      const beforeParagraph = paragraph.cloneNode(false) as HTMLParagraphElement;
      beforeParagraph.append(before);
      nodes.push(beforeParagraph);
    }
    nodes.push(figure);
    if (fragmentHasContent(after)) {
      const afterParagraph = paragraph.cloneNode(false) as HTMLParagraphElement;
      afterParagraph.append(after);
      nodes.push(afterParagraph);
    }
    paragraph.replaceWith(...nodes);
  }
  return images.length > 0;
}

function paragraphHasContent(paragraph: HTMLElement): boolean {
  return Boolean(paragraph.textContent?.trim() || paragraph.querySelector('img, input, figure'));
}

export function insertImageFigure(
  editor: HTMLElement,
  range: Range,
  figure: HTMLElement,
): void {
  const insertion = range.cloneRange();
  insertion.deleteContents();
  const start = insertion.startContainer;
  const blockElement = start.nodeType === Node.ELEMENT_NODE
    ? (start as Element).closest('p, div:not([data-check-item])')
    : start.parentElement?.closest('p, div:not([data-check-item])');
  const block = blockElement instanceof HTMLElement ? blockElement : null;

  if (block && block !== editor && editor.contains(block) && (block === start || block.contains(start))) {
    const tailRange = document.createRange();
    tailRange.selectNodeContents(block);
    tailRange.setStart(start, insertion.startOffset);
    const tail = tailRange.extractContents();
    const afterParagraph = block.cloneNode(false) as HTMLElement;
    afterParagraph.append(tail);
    if (!afterParagraph.hasChildNodes()) afterParagraph.innerHTML = '<br>';

    if (paragraphHasContent(block)) {
      block.after(figure, afterParagraph);
    } else {
      block.before(figure, afterParagraph);
      block.remove();
    }
    placeCaretAtStart(afterParagraph);
    return;
  }

  insertion.insertNode(figure);
  const afterParagraph = document.createElement('p');
  afterParagraph.innerHTML = '<br>';
  figure.after(afterParagraph);
  placeCaretAtStart(afterParagraph);
}

export function placeCaretAtStart(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
