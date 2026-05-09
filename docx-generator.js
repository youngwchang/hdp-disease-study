const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType, ShadingType,
} = require('docx');

/**
 * 마크다운 텍스트를 Word(.docx) Buffer로 변환
 */
async function markdownToDocx(markdown, title = '질환 정보 분석 리포트') {
  const children = [];

  // 문서 제목
  children.push(new Paragraph({
    text: title,
    heading: HeadingLevel.TITLE,
    spacing: { after: 400 },
  }));

  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 수평선
    if (/^---+$/.test(line.trim())) {
      children.push(new Paragraph({ text: '', spacing: { after: 100 } }));
      i++;
      continue;
    }

    // H1
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      children.push(new Paragraph({
        text: line.replace(/^# /, '').trim(),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
      }));
      i++;
      continue;
    }

    // H2
    if (line.startsWith('## ')) {
      children.push(new Paragraph({
        text: line.replace(/^## /, '').trim(),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 360, after: 180 },
      }));
      i++;
      continue;
    }

    // H3
    if (line.startsWith('### ')) {
      children.push(new Paragraph({
        text: line.replace(/^### /, '').trim(),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 240, after: 120 },
      }));
      i++;
      continue;
    }

    // H4
    if (line.startsWith('#### ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.replace(/^#### /, '').trim(), bold: true, size: 22 })],
        spacing: { before: 200, after: 100 },
      }));
      i++;
      continue;
    }

    // 테이블
    if (line.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const table = parseMarkdownTable(tableLines);
      if (table) children.push(table);
      continue;
    }

    // 블록 인용 (> 로 시작)
    if (line.startsWith('>')) {
      children.push(new Paragraph({
        children: [new TextRun({
          text: line.replace(/^>\s*/, '').trim(),
          italics: true,
          color: '666666',
        })],
        indent: { left: 720 },
        spacing: { after: 100 },
      }));
      i++;
      continue;
    }

    // 불릿 리스트
    if (/^[-*]\s/.test(line)) {
      children.push(new Paragraph({
        children: parseInlineMarkdown(line.replace(/^[-*]\s/, '')),
        bullet: { level: 0 },
        spacing: { after: 80 },
      }));
      i++;
      continue;
    }

    // 번호 리스트
    if (/^\d+\.\s/.test(line)) {
      children.push(new Paragraph({
        children: parseInlineMarkdown(line.replace(/^\d+\.\s/, '')),
        numbering: { reference: 'default-numbering', level: 0 },
        spacing: { after: 80 },
      }));
      i++;
      continue;
    }

    // 빈 줄
    if (line.trim() === '') {
      children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      i++;
      continue;
    }

    // 일반 텍스트
    if (line.trim()) {
      children.push(new Paragraph({
        children: parseInlineMarkdown(line),
        spacing: { after: 100 },
      }));
    }

    i++;
  }

  const doc = new Document({
    styles: {
      paragraphStyles: [
        {
          id: 'Normal',
          name: 'Normal',
          run: { font: 'Malgun Gothic', size: 21 },
        },
      ],
    },
    sections: [{ children }],
    numbering: {
      config: [{
        reference: 'default-numbering',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }],
      }],
    },
  });

  return Packer.toBuffer(doc);
}

function parseMarkdownTable(lines) {
  // 구분선(---)만 있는 행 제거
  const dataLines = lines.filter(l => !/^\|[-:| ]+\|$/.test(l.trim()));
  if (dataLines.length < 1) return null;

  const rows = dataLines.map(line => {
    return line.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1).map(c => c.trim());
  });

  const isHeader = (rowIdx) => rowIdx === 0;

  const tableRows = rows.map((cells, rowIdx) =>
    new TableRow({
      children: cells.map(cell =>
        new TableCell({
          children: [new Paragraph({
            children: parseInlineMarkdown(cell),
            alignment: AlignmentType.LEFT,
          })],
          shading: isHeader(rowIdx)
            ? { type: ShadingType.SOLID, color: 'E8F0F9' }
            : undefined,
        })
      ),
    })
  );

  return new Table({
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: 'C0C0C0' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'C0C0C0' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'C0C0C0' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'C0C0C0' },
      insideH: { style: BorderStyle.SINGLE, size: 1, color: 'C0C0C0' },
      insideV: { style: BorderStyle.SINGLE, size: 1, color: 'C0C0C0' },
    },
  });
}

function parseInlineMarkdown(text) {
  const runs = [];
  const regex = /(\*\*(.+?)\*\*)|(`(.+?)`)|(.+?(?=\*\*|`|$))/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match[1]) {
      runs.push(new TextRun({ text: match[2], bold: true }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[4], font: 'Courier New', size: 18, color: '333333' }));
    } else if (match[5]) {
      runs.push(new TextRun({ text: match[5] }));
    }
  }

  return runs.length > 0 ? runs : [new TextRun({ text })];
}

module.exports = { markdownToDocx };
