use infrastructure::Host;

mod controllers;
mod infrastructure;

fn main() {
    Host::new().run();
}
