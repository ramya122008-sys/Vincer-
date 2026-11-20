import streamlit as st
from pypdf import PdfReader
 
    # Current Google Gen AI SDK
    # except ImportError:
    # Compatibility with the legacy google-generativeai SDK

st.title("CiteVerify: Research Paper Assistant")
st.write("Upload a research paper PDF and verify claims against its text using AI.")

# --- SIDEBAR: API CONFIGURATION ---
st.sidebar.header("Configuration")
api_key = st.sidebar.text_input("Enter your Gemini API Key", type="password")

# --- FILE UPLOADER ---
uploaded_file = st.file_uploader("Choose a PDF file", type=["pdf"])

if uploaded_file is not None:
    # Read the PDF using pypdf
    reader = PdfReader(uploaded_file)
    
    # Extract all text from all pages
    full_text = ""
    for i, page in enumerate(reader.pages):
        full_text += f"\n--- Page {i+1} ---\n" + page.extract_text()
        
    st.success(f"Successfully loaded! Total pages: {len(reader.pages)}")
    
    with st.expander("View Extracted Paper Text"):
        st.text_area("Full Document Text", full_text, height=250)

    # --- CLAIM VERIFICATION SECTION ---
    st.subheader("Verify a Claim")
    user_claim = st.text_input("Enter a claim or statement to verify against this paper:")

    if st.button("Check Claim"):
        if not api_key:
            st.error("Please enter your Gemini API key in the sidebar first!")
        elif not user_claim:
            st.warning("Please type a claim to verify.")
        else:
            with st.spinner("Analyzing paper and verifying claim..."):
                try:
                    # Construct the prompt for the model
                    prompt = f"""
                    You are an expert academic research assistant. 
                    Analyze the following research paper text and determine if the user's claim is supported, refuted, or not mentioned.
                    
                    Provide your answer in this format:
                    1. *Verdict:* [Supported / Refuted / Not Mentioned]
                    2. *Explanation:* [Detailed breakdown with reasoning]
                    3. *Direct Quote:* [Exact quote from the text supporting your verdict, if available]

                    RESEARCH PAPER TEXT:
                    {full_text[:30000]}  # Limiting length to fit context window safely

                    USER CLAIM:
                    {user_claim}
                    """
                    
                    # Call Gemini 2.5 Flash using whichever SDK is installed
                    if hasattr(genai, "Client"):
                        client = genai.Client(api_key=api_key)
                        response = client.models.generate_content(
                            model="gemini-2.5-flash",
                            contents=prompt,
                        )
                    else:
                        genai.configure(api_key=api_key)
                        model = genai.GenerativeModel("gemini-2.5-flash")
                        response = model.generate_content(prompt)
                    
                    st.markdown("### Verification Result")
                    st.write(response.text)
                    
                except Exception as e:
                    st.error(f"An error occured: {str(e)}")