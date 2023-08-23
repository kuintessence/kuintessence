use crate::prelude::*;
use rand::Rng;
use std::collections::HashMap;
use uuid::Uuid;

impl NodeRelation {
    /// 改变节点关系中的旧 id 为新 id
    ///
    /// # 参数
    ///
    /// * `id_map` - 旧 id 与新 id 对照 map
    pub fn update_id(&mut self, id_map: &HashMap<Uuid, Uuid>) {
        for (old_id, new_id) in id_map.iter() {
            if old_id.eq(&self.from_id) {
                self.from_id = new_id.to_owned();
            }
            if old_id.eq(&self.to_id) {
                self.to_id = new_id.to_owned();
            }
        }
    }
}

impl Filler {
    /// 匹配输入提供文本的正则部分，返回填充后的文本列表
    ///
    /// # 参数
    ///
    /// * `content` - 匹配替换的文本内容
    /// * `regex_to_match` - 匹配的文本
    /// * `fill_count` - 替换生成文本次数
    pub fn fill_match_regex(
        &self,
        content: &str,
        regex_to_match: &str,
        fill_count: usize,
    ) -> Vec<String> {
        let mut texts = vec![content.to_owned(); fill_count];
        match self {
            Filler::AutoNumber { start, step } => {
                let mut current = start.to_owned();
                for text in texts.iter_mut() {
                    *text = text.replace(regex_to_match, &current.to_string());
                    current += *step;
                }
            }
            Filler::Enumeration { items } => {
                for text in texts.iter_mut() {
                    let n: usize = rand::thread_rng().gen_range(0..items.len());
                    *text = text.replace(regex_to_match, items.get(n).unwrap());
                }
            }
        };
        texts
    }
}

impl NodeInputSlot {
    /// 返回插槽上输入的个数
    pub fn inputs_count(&self) -> usize {
        match &self.kind {
            NodeInputSlotKind::Text { contents, .. } => contents.as_ref().unwrap().len(),
            NodeInputSlotKind::File { contents, .. } => contents.as_ref().unwrap().len(),
            NodeInputSlotKind::Unknown => unreachable!(),
        }
    }

    /// 返回插槽上所有的输入
    pub fn inputs(&self) -> Vec<Input> {
        match &self.kind {
            NodeInputSlotKind::Text { contents, .. } => {
                contents.as_ref().unwrap().iter().map(|el| Input::Text(el.to_owned())).collect()
            }
            NodeInputSlotKind::File { contents, .. } => {
                contents.as_ref().unwrap().iter().map(|el| Input::File(el.to_owned())).collect()
            }
            NodeInputSlotKind::Unknown => unreachable!(),
        }
    }

    /// 返回插槽上所有文件输入
    pub fn file_inputs(&self) -> anyhow::Result<&[FileInput]> {
        Ok(match &self.kind {
            NodeInputSlotKind::File { contents, .. } => contents.as_ref().unwrap(),
            _ => anyhow::bail!("InputSlot type is not file!"),
        })
    }
}

impl NodeInputSlotKind {
    /// 判断输入插槽与一个输出插槽数据类型是否相同
    ///
    /// # 参数
    ///
    /// * `r` - 输出插槽
    pub fn is_same_kind(&self, r: &NodeDraftOutputSlotKind) -> anyhow::Result<bool> {
        Ok(match self {
            NodeInputSlotKind::Text { .. } => {
                matches!(r, NodeDraftOutputSlotKind::Text { .. })
            }
            NodeInputSlotKind::File { .. } => {
                matches!(r, NodeDraftOutputSlotKind::File { .. })
            }
            NodeInputSlotKind::Unknown => anyhow::bail!("Unknown input type!"),
        })
    }
}
