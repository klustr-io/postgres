use std::sync::Arc;

use axum::extract::State;
use axum::response::Response;
use compute_api::responses::ComputeStatus;
use http::StatusCode;

use crate::compute::ComputeNode;
use crate::http::JsonResponse;

/// Collect current Postgres usage insights.
pub(in crate::http) async fn get_insights(State(compute): State<Arc<ComputeNode>>) -> Response {
    let status = compute.get_status();
    if status != ComputeStatus::Running {
        return JsonResponse::invalid_status(status);
    }

    match compute.collect_insights().await {
        Ok(insights) => JsonResponse::success(StatusCode::OK, insights),
        Err(error) => JsonResponse::error(StatusCode::SERVICE_UNAVAILABLE, error),
    }
}
