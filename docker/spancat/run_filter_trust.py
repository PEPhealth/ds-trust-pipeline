from typing import Dict
import emoji
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.feature_extraction.text import CountVectorizer
import string
import logging
import time
from tqdm import tqdm

# Initialize CountVectorizer once
vectorizer = CountVectorizer()


def contains_emoji(text: str) -> bool:
    """
    Check if the given text contains any emojis.

    Args:
        text (str): The input text.

    Returns:
        bool: True if the text contains emojis, False otherwise.
    """
    return any(char in emoji.EMOJI_DATA for char in text)

def validate_and_update_relevance(span):
    """
    Validate spans and set relevant to 0 if the theme_text contains emojis.

    Args:
        span (dict): A span dictionary with keys like 'theme_text', 'relevant'.

    Returns:
        dict: Updated span dictionary.
    """
    # Check if theme_text contains emojis
    if contains_emoji(span['theme_text']):
        logging.info(f"Setting 'relevant' to 0 for span containing emoji: {span['theme_text']}")
        span['relevant'] = 0
    return span

def execution_time(func):
    """Decorator to measure execution time of a function."""
    def wrapper(*args, **kwargs):
        start_time = time.perf_counter()  # Use perf_counter for more precise timing
        result = func(*args, **kwargs)
        end_time = time.perf_counter()
        execution_time = end_time - start_time
        print(f"Function {func.__name__} took {execution_time:.4f} seconds to execute")
        return result
    return wrapper

def calculate_cosine_similarity(text1: str, text2: str, vectorizer=vectorizer) -> float:
    """
    Calculates the cosine similarity between two texts.

    Args:
        text1 (str): The first text.
        text2 (str): The second text.
        vectorizer: The CountVectorizer instance to use for text vectorization.

    Returns:
        float: The cosine similarity between the two texts.
    """
    try:
        vectors = vectorizer.fit_transform([text1, text2])
        cosine_sim = cosine_similarity(vectors[0], vectors[1])[0][0]
        return cosine_sim
    except Exception as e:
        print(f"Error calculating cosine similarity: {e}")
        return 0.0

def check_span_overlap(span1: Dict, span2: Dict, threshold: float = 0.7) -> bool:
    """
    Determines if two text spans overlap both in their character positions and semantic content.

    Args:
        span1 (dict): A dictionary containing the start and end character positions and the text of the first span.
        span2 (dict): A dictionary containing the start and end character positions and the text of the second span.
        threshold (float): Cosine similarity threshold for determining overlap (default is 0.7).

    Returns:
        bool: True if the spans overlap in character positions and their cosine similarity exceeds the threshold, False otherwise.
    """
    try:
        span1_start, span1_end = span1['theme_start_char'], span1['theme_end_char']
        span2_start, span2_end = span2['theme_start_char'], span2['theme_end_char']

        # Check if character ranges overlap
        if span1_end >= span2_start and span2_end >= span1_start:
            translator = str.maketrans('', '', string.punctuation)
            model_text = span1['theme_text'].translate(translator).lower()
            manual_text = span2['theme_text'].translate(translator).lower()

            model_words = set(model_text.split())
            manual_words = set(manual_text.split())
            if model_words & manual_words:
                cosine_sim = calculate_cosine_similarity(model_text, manual_text)
                return cosine_sim > threshold
        return False
    except KeyError as e:
        print(f"Missing key in span dictionary: {e}")
        return False
    except Exception as e:
        print(f"Error in check_span_overlap: {e}")
        return False

@execution_time
def fix_same_subdomain_overlapping_spans(spans_by_comment):
    for comment_id, spans in spans_by_comment.items():
        for i in range(len(spans)):
            for j in range(i + 1, len(spans)):
                if check_span_overlap(spans[i], spans[j]):
                    if spans[i]['theme'] == spans[j]['theme']:
                        if len(spans[i]['theme_text']) < len(spans[j]['theme_text']):
                            spans[i]['relevant'] = 0
                        else:
                            spans[j]['relevant'] = 0
    return spans_by_comment

@execution_time
def fix_different_subdomain_overlapping_spans(spans_by_comment, embedding_model, knn_classifier, le):
    """
    Apply a fix to spans from different subdomains.

    This function iterates over spans grouped by comments and checks for overlaps between spans. If an overlap is found and the spans belong to different subdomains, the function updates the 'relevant' field of the shorter span to 0 and assigns the predicted subdomain based on the theme text to the longer span using a k-nn classifier.

    Args:
        spans_by_comment (dict): A dictionary where keys are comment IDs and values are lists of spans.
        embedding_model: The SentenceTransformer model used for encoding theme text.
        knn_classifier: The k-nn classifier model for predicting subdomains.
        le: The label encoder for inverse transforming predicted subdomains.

    Returns:
        dict: A dictionary with the same structure as 'spans_by_comment' but with updated spans after fixing different subdomain overlaps.
    """
    for comment_id, spans in tqdm(spans_by_comment.items(), desc="Fixing spans", unit="comment"):
        comment = next(span['cleaned_comment'] for span in spans)  # Get comment from any span
        for i in range(len(spans)):
            for j in range(i + 1, len(spans)):
                if check_span_overlap(spans[i], spans[j]):
                    if spans[i]['theme'] != spans[j]['theme']:
                        if len(spans[i]['theme_text']) < len(spans[j]['theme_text']):
                            spans[i]['relevant'] = 0
                            theme_text = spans[j]['theme_text']
                            index = j
                        else:
                            spans[j]['relevant'] = 0
                            theme_text = spans[i]['theme_text']
                            index = i

                        # Use k-nn classifier to determine which subdomain they belong to
                        embedding = embedding_model.encode(theme_text, show_progress_bar=False)
                        predicted_theme = le.inverse_transform(knn_classifier.predict([embedding]))
                        if predicted_theme[0] in [spans[i]['theme_text'], spans[j]['theme_text']]:
                            spans[index]['theme'] = predicted_theme[0]
    return spans_by_comment

def validate_span(span):
    # Extract relevant information
    cleaned_comment = span['cleaned_comment']
    start_char = int(span['theme_start_char'])
    end_char = int(span['theme_end_char'])
    theme_text = span['theme_text']

    # Validate character indexes
    if start_char < 0 or end_char > len(cleaned_comment) or start_char > end_char:
        logging.error(f"Invalid char indexes in span: {span}")
        return False

    # Validate theme_text
    expected_text = cleaned_comment[start_char:end_char]
    if theme_text != expected_text:
        logging.error(f"Theme text does not match in span: {span}")
        return False

    return True

def fix_punctuation(cleaned_comment, theme_text, start_char, end_char):
    """
    Adjusts the `theme_text` to remove trailing punctuation (except '!' or '?') and updates the start and end character indices accordingly.

    Args:
        cleaned_comment (str): The full cleaned comment text.
        theme_text (str): The initial theme text extracted from the comment.
        start_char (int): The starting character index of the theme text in the cleaned comment.
        end_char (int): The ending character index of the theme text in the cleaned comment.

    Returns:
        tuple: A tuple containing the updated theme text, start character index, and end character index.
    """
    try:
        start_char = int(start_char)
        end_char = int(end_char)
    except ValueError:
        logging.error(f"Invalid start_char or end_char values: {start_char}, {end_char}")
        return theme_text, start_char, end_char
    # Remove trailing punctuation (except ! or ?) from theme_text
    while end_char > start_char and (cleaned_comment[end_char - 1] in string.punctuation.replace("!", "").replace("?", "") or cleaned_comment[end_char - 1].isspace()):
        end_char -= 1

    # Extract the updated theme_text
    theme_text = cleaned_comment[start_char:end_char]

    # Add trailing ! or ? if present in cleaned_comment but missing in theme_text
    if end_char < len(cleaned_comment) and cleaned_comment[end_char] in ("!", "?"):
        end_char += 1
        theme_text = cleaned_comment[start_char:end_char]

    return theme_text, start_char, end_char

@execution_time
def time_fix_punctuation(spans):
    for span in spans:
        # Validate and update relevance based on emojis
        span = validate_and_update_relevance(span)
        if validate_span(span):
            span['theme_text'], span['theme_start_char'], span['theme_end_char'] = fix_punctuation(
                span['cleaned_comment'],
                span['theme_text'],
                span['theme_start_char'],
                span['theme_end_char']
            )
    return spans
