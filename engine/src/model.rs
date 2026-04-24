const MAGIC: &[u8; 4] = b"TDLM";
const VERSION: u32 = 1;
const HEADER_U32_COUNT: usize = 8;
const BLOCK_U32_COUNT: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    Paragraph,
    Table,
    Image,
    Shape,
    Unknown(u32),
}

impl BlockKind {
    pub fn from_u32(value: u32) -> Self {
        match value {
            1 => Self::Paragraph,
            2 => Self::Table,
            3 => Self::Image,
            4 => Self::Shape,
            other => Self::Unknown(other),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paragraph => "paragraph",
            Self::Table => "table",
            Self::Image => "image",
            Self::Shape => "shape",
            Self::Unknown(_) => "unknown",
        }
    }
}

#[derive(Clone, Debug)]
pub struct BlockInput {
    pub kind: BlockKind,
    pub width: u32,
    pub height: u32,
    pub min_height: u32,
    pub flags: u32,
    pub source_index: u32,
}

#[derive(Clone, Debug)]
pub struct LayoutInput {
    pub page_width: u32,
    pub page_height: u32,
    pub margin_top: u32,
    pub margin_right: u32,
    pub margin_bottom: u32,
    pub margin_left: u32,
    pub blocks: Vec<BlockInput>,
}

#[derive(Clone, Debug)]
pub struct BoxLayout {
    pub kind: BlockKind,
    pub source_index: u32,
    pub flags: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub source_start: u32,
    pub visible_height: u32,
    pub fragment_index: u32,
    pub fragment_count: u32,
}

#[derive(Clone, Debug)]
pub struct PageLayout {
    pub index: u32,
    pub boxes: Vec<BoxLayout>,
}

#[derive(Clone, Debug)]
pub struct LayoutResult {
    pub page_width: u32,
    pub page_height: u32,
    pub content_width: u32,
    pub content_height: u32,
    pub block_count: u32,
    pub split_blocks: u32,
    pub pages: Vec<PageLayout>,
}

pub fn decode_layout_input(bytes: &[u8]) -> Result<LayoutInput, &'static str> {
    if bytes.len() < 4 + HEADER_U32_COUNT * 4 {
        return Err("input too short");
    }
    if &bytes[0..4] != MAGIC {
        return Err("bad magic");
    }

    let mut offset = 4;
    let version = read_u32(bytes, &mut offset)?;
    if version != VERSION {
        return Err("unsupported version");
    }

    let page_width = read_u32(bytes, &mut offset)?;
    let page_height = read_u32(bytes, &mut offset)?;
    let margin_top = read_u32(bytes, &mut offset)?;
    let margin_right = read_u32(bytes, &mut offset)?;
    let margin_bottom = read_u32(bytes, &mut offset)?;
    let margin_left = read_u32(bytes, &mut offset)?;
    let block_count = read_u32(bytes, &mut offset)? as usize;

    if block_count > 100_000 {
        return Err("too many blocks");
    }

    let required = 4 + HEADER_U32_COUNT * 4 + block_count * BLOCK_U32_COUNT * 4;
    if bytes.len() < required {
        return Err("truncated block list");
    }

    let mut blocks = Vec::with_capacity(block_count);
    for _ in 0..block_count {
        let kind = BlockKind::from_u32(read_u32(bytes, &mut offset)?);
        let width = read_u32(bytes, &mut offset)?;
        let height = read_u32(bytes, &mut offset)?;
        let min_height = read_u32(bytes, &mut offset)?;
        let flags = read_u32(bytes, &mut offset)?;
        let source_index = read_u32(bytes, &mut offset)?;
        blocks.push(BlockInput {
            kind,
            width,
            height,
            min_height,
            flags,
            source_index,
        });
    }

    Ok(LayoutInput {
        page_width: page_width.max(1),
        page_height: page_height.max(1),
        margin_top,
        margin_right,
        margin_bottom,
        margin_left,
        blocks,
    })
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Result<u32, &'static str> {
    if *offset + 4 > bytes.len() {
        return Err("unexpected end of input");
    }
    let value = u32::from_le_bytes([
        bytes[*offset],
        bytes[*offset + 1],
        bytes[*offset + 2],
        bytes[*offset + 3],
    ]);
    *offset += 4;
    Ok(value)
}
