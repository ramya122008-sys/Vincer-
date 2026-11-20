"""
CiteVerify — AI-powered academic citation verification.
Run: python app.py
Open: http://127.0.0.1:5000

AI is optional. Without ANTHROPIC_API_KEY, the app uses transparent
retrieval/heuristic checks and marks uncertain results NEEDS_REVIEW.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import time
import hashlib
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from flask import Flask, jsonify, render_template_string, request, Response
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / ".cache"
CACHE_DIR.mkdir(exist_ok=True)
HISTORY_FILE = BASE_DIR / "review_history.json"
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt"}
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
VERDICTS = {
    "supported", "partially_supported", "unsupported",
    "contradictory", "possibly_outdated", "needs_review"
}
VERDICT_LABELS = {
    "supported": "SUPPORTED",
    "partially_supported": "PARTIALLY SUPPORTED",
    "unsupported": "UNSUPPORTED",
    "contradictory": "CONTRADICTORY",
    "possibly_outdated": "POTENTIALLY OUTDATED",
    "needs_review": "NEEDS REVIEW"
}
DISCLAIMER = (
    "Automated results are decision support, not a final academic judgment. "
    "Confidence reflects evidence strength and uncertainty, not a guarantee. "
    "Always check findings against the original publication."
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
LATEST_REPORT: dict[str, Any] | None = None


def llm_available() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


def read_document(filename: str, data: bytes) -> str:
        ext = Path(filename).suffix.lower()
    if ext == ".txt":
        return data.decode("utf-8", errors="replace")
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            try:
                from PyPDF2 import PdfReader
            except ImportError:
                raise RuntimeError("PDF support requires pypdf or PyPDF2")

        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)

    if ext == ".docx":
        try:
            from docx import Document
        except ImportError:
            raise RuntimeError("DOCX support requires python-docx")

        document = Document(io.BytesIO(data))
        return "\n".join(paragraph.text for paragraph in document.paragraphs)

    raise ValueError(f"Unsupported document type: {ext}")