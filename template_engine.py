from datetime import datetime, timezone
from jinja2 import Environment, FileSystemLoader, select_autoescape
from config import config

def _make_env() -> Environment:
    env = Environment(
        loader=FileSystemLoader(config.templates_dir),
        autoescape=select_autoescape(['html'])
    )
    env.globals['now'] = datetime.now(timezone.utc)
    return env

env = _make_env()

def render_template(template_id: str, data: dict) -> tuple[str, str]:
    template = env.get_template(f"{template_id}.html")
    html_body = template.render(**data)

    module = template.make_module(vars=data)
    subject = module.subject if hasattr(module, 'subject') else data.get('subject', 'Message')

    return subject, html_body
