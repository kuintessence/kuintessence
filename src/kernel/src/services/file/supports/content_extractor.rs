use crate::prelude::*;
use std::collections::HashMap;

pub struct ContentExtractorService;

#[async_trait]
impl IContentExtractorService for ContentExtractorService {
    async fn extract(&self, content: &str, opt: ExtractOption) -> AnyhowResult<ExtractResult> {
        let mut iter = content.lines().skip(opt.start_row as usize - 1);
        let mut new_lines: Vec<_> = vec![];
        let regex = regex::Regex::new(&opt.regex)?;
        for _ in 0..opt.rows_per_page {
            if let Some(el) = iter.next() {
                new_lines.push(el);
                continue;
            }
            break;
        }

        let txt = new_lines.join("\n");
        if opt.regex.is_empty() {
            return Ok(ExtractResult::PlainText(txt));
        }
        new_lines.clear();

        let mut catched_name_value_map: Vec<CapturedValue> = vec![];

        for caps in regex.captures_iter(&txt) {
            let mut position_value_map: HashMap<_, _> = HashMap::new();
            let mut name_value_map: HashMap<_, _> = HashMap::new();
            for (nth, name) in regex.capture_names().enumerate() {
                position_value_map.insert(
                    nth,
                    caps.get(nth).map(|el| el.as_str().to_string()).to_owned(),
                );
                if let Some(el) = name {
                    name_value_map.insert(
                        el.to_owned(),
                        caps.name(el).map(|el| el.as_str().to_string()).to_owned(),
                    );
                }
            }
            catched_name_value_map.push(CapturedValue {
                position_value_map,
                name_value_map,
            });
        }

        Ok(ExtractResult::Capture(catched_name_value_map))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTENT: &str = r#"line1
line2
line3
'Citizen Kane' (1941), 'The Wizard of Oz' (1939), 'M' (1931).
line5
'The Wizard of Oz' (1939),
line7
line8"#;

    #[tokio::test]
    async fn extract_position_captured() {
        let service = ContentExtractorService;
        let result = service
            .extract(
                CONTENT,
                ExtractOption {
                    start_row: 2,
                    rows_per_page: 5,
                    regex: r"'([^']+)'\s+\((\d{4})\)".to_string(),
                },
            )
            .await
            .unwrap();
        let result = serde_json::to_string_pretty(&result).unwrap();
        println!("{result}");
    }

    #[tokio::test]
    async fn extract_name_captured() {
        let service = ContentExtractorService;
        let result = service
            .extract(
                CONTENT,
                ExtractOption {
                    start_row: 2,
                    rows_per_page: 5,
                    regex: r"'(?P<title>[^']+)'\s+\((?P<year>\d{4})\)".to_string(),
                },
            )
            .await
            .unwrap();
        let result = serde_json::to_string_pretty(&result).unwrap();
        println!("{result}");
    }

    #[tokio::test]
    async fn extract_plain_text() {
        let service = ContentExtractorService;
        let result = service
            .extract(
                CONTENT,
                ExtractOption {
                    start_row: 2,
                    rows_per_page: 5,
                    regex: r"".to_string(),
                },
            )
            .await
            .unwrap();
        let result = serde_json::to_string_pretty(&result).unwrap();
        println!("{result}");
    }
}

#[tokio::test]
async fn dsaf() {
    let xx = std::fs::read("xxx.txt").unwrap();
    let s = String::from_utf8(xx).unwrap();

    let service = ContentExtractorService;
    let result = service
        .extract(
            &s,
            ExtractOption {
                start_row: 1,
                rows_per_page: 500,
                regex: r#"(?:connection|con)[\n\s]*?\.(?P<mname>\w+)(?:::<(?P<ToValue>[^,]*), (?P<FromValue>.*)>)?\((?P<args>[\s\S]*?)\)[\s\n]*.await\?"#.to_string(),
            },
        )
        .await
        .unwrap();
    let result = serde_json::to_string_pretty(&result).unwrap();
    println!("{result}");
    // println!("{s}");
}
