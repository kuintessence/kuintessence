use syn::{parse2, ItemFn};

pub fn internal_authorize(
    attr: proc_macro2::TokenStream,
    body: proc_macro2::TokenStream,
) -> proc_macro2::TokenStream {
    let flag = attr.to_string().eq("allow_none_user_id");
    let body: ItemFn = match parse2(body) {
        Ok(x) => x,
        Err(e) => return e.into_compile_error(),
    };
    let (visibility, attrs, block, sig) = (&body.vis, &body.attrs, &body.block.stmts, &body.sig);
    quote::quote! {
        #(#attrs)*
        #visibility #sig {
            let user_info: Option<alice_architecture::authorization::UserInfo> = {
                let extensions = ::actix_web::HttpMessage::extensions(&raw_req);
                let user_info: Option<&alice_architecture::authorization::UserInfo> = extensions.get();
                match user_info {
                    Some(x) => Some(x.clone()),
                    None => {
                        if !#flag{
                            return actix_web::web::Json(ResponseBase::err(400, "No Token."));
                        }
                        None
                    }
                }
            };
            #(#block)*
        }
    }
}
