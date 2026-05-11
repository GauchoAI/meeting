use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::json;
use tempfile::TempDir;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity};
use transcribe_rs::onnx::Quantization;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "8793";

struct AppState {
    model: Mutex<ParakeetModel>,
    model_path: PathBuf,
    language: Option<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let host = env::var("PARAKEET_STT_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_string());
    let port = env::var("PARAKEET_STT_PORT").unwrap_or_else(|_| DEFAULT_PORT.to_string());
    let model_path = parakeet_model_path();
    let language = env::var("PARAKEET_STT_LANGUAGE")
        .ok()
        .filter(|value| !value.trim().is_empty());

    eprintln!("[parakeet-stt] loading {}", model_path.display());
    let loaded_at = Instant::now();
    let model = ParakeetModel::load(&model_path, &Quantization::Int8)?;
    eprintln!(
        "[parakeet-stt] loaded in {}ms",
        loaded_at.elapsed().as_millis()
    );

    let state = Arc::new(AppState {
        model: Mutex::new(model),
        model_path,
        language,
    });
    let server = Server::http(format!("{host}:{port}"))?;
    eprintln!("[parakeet-stt] listening on http://{host}:{port}/transcribe");

    for request in server.incoming_requests() {
        let state = Arc::clone(&state);
        if let Err(error) = handle_request(request, state) {
            eprintln!("[parakeet-stt] request failed: {error}");
        }
    }

    Ok(())
}

fn handle_request(
    mut request: Request,
    state: Arc<AppState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or(&url);
    match (request.method(), path) {
        (&Method::Get, "/health") => {
            let body = json!({
                "ok": true,
                "model": "parakeet-tdt-0.6b-v3-int8",
                "modelPath": state.model_path,
                "language": state.language,
            });
            request.respond(json_response(body, 200))?;
        }
        (&Method::Post, "/transcribe") => {
            let extension = query_param(&url, "extension").unwrap_or_else(|| "webm".to_string());
            let mut audio = Vec::new();
            request.as_reader().read_to_end(&mut audio)?;
            let started = Instant::now();
            match transcribe_audio(&state, &audio, &extension) {
                Ok(text) => {
                    let body = json!({
                        "text": text,
                        "model": "parakeet-tdt-0.6b-v3-int8",
                        "modelPath": state.model_path,
                        "elapsedMs": started.elapsed().as_millis() as u64,
                    });
                    request.respond(json_response(body, 200))?;
                }
                Err(error) => {
                    let body = json!({ "error": error.to_string() });
                    request.respond(json_response(body, 500))?;
                }
            }
        }
        _ => {
            request.respond(json_response(json!({ "error": "not found" }), 404))?;
        }
    }
    Ok(())
}

fn transcribe_audio(
    state: &AppState,
    audio: &[u8],
    extension: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if audio.is_empty() {
        return Ok(String::new());
    }

    let temp = TempDir::new()?;
    let source = temp
        .path()
        .join(format!("chunk-source.{}", safe_extension(extension)));
    let wav = temp.path().join("chunk.wav");
    fs::write(&source, audio)?;
    convert_to_wav(&source, &wav)?;

    let samples = transcribe_rs::audio::read_wav_samples(&wav)?;
    let mut model = state
        .model
        .lock()
        .map_err(|_| "Parakeet model lock poisoned")?;
    let result = model.transcribe_with(
        &samples,
        &ParakeetParams {
            language: state.language.clone(),
            timestamp_granularity: Some(TimestampGranularity::Segment),
        },
    )?;

    Ok(result.text.trim().to_string())
}

fn convert_to_wav(
    source: &Path,
    destination: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ffmpeg = env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_string());
    let output = Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            source.to_str().ok_or("invalid source path")?,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            destination.to_str().ok_or("invalid destination path")?,
        ])
        .output()?;

    if output.status.success() {
        return Ok(());
    }

    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!("ffmpeg failed to decode {}: {}", source.display(), detail).into())
}

fn json_response(value: serde_json::Value, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(&value)
        .unwrap_or_else(|_| b"{\"error\":\"json encode failed\"}".to_vec());
    let mut response = Response::from_data(body).with_status_code(StatusCode(status));
    response.add_header(
        Header::from_bytes(&b"content-type"[..], &b"application/json"[..]).expect("valid header"),
    );
    response
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return Some(percent_decode(value));
        }
    }
    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn safe_extension(extension: &str) -> String {
    let cleaned: String = extension
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(12)
        .collect();
    if cleaned.is_empty() {
        "webm".to_string()
    } else {
        cleaned
    }
}

fn parakeet_model_path() -> PathBuf {
    if let Ok(path) = env::var("PARAKEET_STT_MODEL_PATH") {
        return PathBuf::from(path);
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join("Library/Application Support/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8")
}
