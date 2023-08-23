use infrastructure::Host;
mod controllers;
mod infrastructure;
mod internal_message_consumers;
fn main() {
    Host::new().run();
}
