import os
import json
import logging
from typing import List, Dict, Any, Tuple
import numpy as np
import faiss
from google import genai

logger = logging.getLogger("faiss_retriever")

class FAISSMemoryRetriever:
    """RAG Retriever module using Google GenAI embeddings and FAISS vector indexing
    to retrieve past verified task runs and failures for agent planning.
    """

    def __init__(self, embedding_model: str = "gemini-embedding-2"):
        self.embedding_model = embedding_model
        self.client = genai.Client()
        self.index = None
        self.metadata: List[Dict[str, Any]] = []
        self.dimension = None

    def get_embedding(self, text: str) -> np.ndarray:
        """Generate vector embedding for a given text snippet."""
        try:
            response = self.client.models.embed_content(
                model=self.embedding_model,
                contents=text
            )
            # Access first item in embeddings list returned by google-genai SDK
            embedding_vals = response.embeddings[0].values
            return np.array(embedding_vals, dtype=np.float32)
        except Exception as e:
            logger.error(f"Error generating embedding: {e}")
            raise e

    def build_index_from_records(self, task_records: List[Dict[str, Any]]):
        """Index a list of historical task execution dicts into FAISS."""
        if not task_records:
            logger.warning("No task records provided to build FAISS index.")
            return

        embeddings = []
        valid_metadata = []

        for record in task_records:
            req = record.get("requirement", "") or record.get("task_description", "")
            status = record.get("status", "unknown")
            error = record.get("error_log", "")
            
            content_snippet = f"Task: {req} | Status: {status}"
            if error:
                content_snippet += f" | Error: {error}"

            vector = self.get_embedding(content_snippet)
            embeddings.append(vector)
            valid_metadata.append(record)

        if embeddings:
            matrix = np.array(embeddings, dtype=np.float32)
            self.dimension = matrix.shape[1]
            self.index = faiss.IndexFlatL2(self.dimension)
            self.index.add(matrix)
            self.metadata = valid_metadata
            logger.info(f"FAISS index built with {self.index.ntotal} records.")

    def query_similar_runs(self, current_requirement: str, top_k: int = 3) -> List[Dict[str, Any]]:
        """Query top_k similar historical tasks for context retrieval."""
        if self.index is None or self.index.ntotal == 0:
            return []

        query_vec = np.array([self.get_embedding(current_requirement)], dtype=np.float32)
        distances, indices = self.index.search(query_vec, min(top_k, self.index.ntotal))

        results = []
        for idx in indices[0]:
            if idx < len(self.metadata) and idx != -1:
                results.append(self.metadata[idx])
        return results

    def format_retrieved_context(self, matches: List[Dict[str, Any]]) -> str:
        """Format retrieved records into a prompt section for the Gemini Planner."""
        if not matches:
            return ""

        context_str = "\n--- HISTORICAL TASK MEMORY (RAG CONTEXT) ---\n"
        for i, match in enumerate(matches, 1):
            req = match.get("requirement", "N/A")
            status = match.get("status", "N/A")
            context_str += f"{i}. Past Requirement: {req} (Status: {status})\n"
            if "key_learnings" in match:
                context_str += f"   Learning: {match['key_learnings']}\n"
        context_str += "--- END HISTORICAL MEMORY ---\n"
        return context_str


if __name__ == "__main__":
    print("Testing FAISSMemoryRetriever initialization...")
    retriever = FAISSMemoryRetriever()
    print("Module initialized successfully.")