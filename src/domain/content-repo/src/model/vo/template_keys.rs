use std::str::FromStr;

use handlebars::{
    template::{Parameter, TemplateElement},
    Template,
};

#[derive(Debug)]
pub struct TemplateKeys(pub Vec<String>);

impl FromStr for TemplateKeys {
    type Err = anyhow::Error;

    fn from_str(source: &str) -> Result<Self, Self::Err> {
        let template = Template::compile(source)?;
        handle_template(&template).map(TemplateKeys)
    }
}

fn handle_template(template: &Template) -> anyhow::Result<Vec<String>> {
    let mut keys = vec![];
    for element in template.elements.iter() {
        match element {
            TemplateElement::HtmlExpression(_) => {
                anyhow::bail!("[HtmlExpression] is not implemented!")
            }
            TemplateElement::Expression(el) => match el.name {
                Parameter::Name(_) => anyhow::bail!("[Expression::Name] is not implemented!"),
                Parameter::Path(ref path) => match path.to_owned() {
                    handlebars::Path::Relative((_, s)) => {
                        let key = s
                            .split('.')
                            .collect::<Vec<_>>()
                            .first()
                            .ok_or(anyhow::anyhow!(
                                "Something went wrong in [Expression::Path::Relative]!"
                            ))?
                            .to_string();
                        keys.push(key);
                    }
                    handlebars::Path::Local(_) => {
                        anyhow::bail!("[Expression::Path::Local] is not implemented!")
                    }
                },
                Parameter::Literal(_) => {
                    anyhow::bail!("[Expression::literal] is not implemented!")
                }
                Parameter::Subexpression(_) => {
                    anyhow::bail!("[Expression::Subexpression] is not implemented!")
                }
            },
            TemplateElement::HelperBlock(el) => {
                for param in el.params.clone() {
                    match param {
                        Parameter::Name(_) => {
                            anyhow::bail!("[HelperBlock::Parameter::Name] is not implemented!")
                        }
                        Parameter::Path(path) => match path {
                            handlebars::Path::Relative((_, s)) => {
                                let key = s
                                .split('.')
                                .collect::<Vec<_>>()
                                .first()
                                .ok_or(anyhow::anyhow!("Something went wrong in [HelperBlock::Parameter::Path::Relative]!"))?
                                .to_string();
                                keys.push(key);
                            }
                            handlebars::Path::Local(_) => {
                                anyhow::bail!(
                                    "[HelperBlock::Parameter::Path::Local] is not implemented!"
                                )
                            }
                        },
                        Parameter::Literal(_) => {
                            anyhow::bail!("[HelperBlock::Parameter::Literal] is not implemented!")
                        }
                        Parameter::Subexpression(_) => {
                            anyhow::bail!(
                                "[HelperBlock::Parameter::Subexpression] is not implemented!"
                            )
                        }
                    }
                    match &el.template {
                        Some(template) => {
                            let new_keys = handle_template(template)?;
                            for key in new_keys {
                                keys.push(key);
                            }
                        }
                        None => {}
                    }
                }
            }
            TemplateElement::DecoratorExpression(_) => {
                anyhow::bail!("[DecoratorExpressionis] is not implemented!")
            }
            TemplateElement::DecoratorBlock(_) => {
                anyhow::bail!("[DecoratorBlockis] is not implemented!")
            }
            TemplateElement::PartialExpression(_) => {
                anyhow::bail!("[PartialExpressionis] is not implemented!")
            }
            TemplateElement::PartialBlock(_) => {
                anyhow::bail!("PartialBlockis is not implemented!")
            }
            TemplateElement::RawString(_) | TemplateElement::Comment(_) => {}
        }
    }
    Ok(keys)
}
